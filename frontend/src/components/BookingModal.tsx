import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { bookingsApi, contractsApi, pricingApi, ContractWithStats } from '../api/client';
import { useAuth } from '../context/AuthContext';
import InlineCheckout from './InlineCheckout';
import PaymentSuccess from './PaymentSuccess';
import ServiceLineItem from './ui/ServiceLineItem';
import { formatBRL } from '../utils/format';
import { ignoreMultiClick } from '../hooks/useWizardStep';
import { TIER_META, getMeta } from '../constants/adminMeta';
import BrandLoader from './ui/BrandLoader';
import { XCircle } from 'lucide-react';

interface BookingModalProps {
    isOpen?: boolean;
    date: string;
    time: string;
    tier: string;
    price: number;
    onClose: () => void;
    onBooked: () => void;
    /** "Criar Novo Contrato": abre o ContractWizard pré-preenchido com a faixa, a data e a hora do horário (D16). */
    onNewContract?: (date: string, time: string, tier: string) => void;
}

const TIER_LABELS: Record<string, string> = {
    COMERCIAL: '🏢 Comercial',
    AUDIENCIA: '🎤 Audiência',
    SABADO: '🌟 Sábado Premium',
};

type Step = 'choose' | 'avulso_addons' | 'avulso_checkout' | 'plan_extras_checkout' | 'held' | 'processing' | 'done' | 'error';

// ─── Countdown Timer Component ──────────────────────────
function CountdownTimer({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
    const [remaining, setRemaining] = useState(() => {
        const diff = new Date(expiresAt).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        const timer = setInterval(() => {
            const diff = new Date(expiresAt).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) {
                clearInterval(timer);
                onExpire();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [expiresAt, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const pct = Math.max(0, (remaining / 600) * 100); // 600s = 10 min

    return (
        <div style={{ marginBottom: '20px' }}>
            <div style={{
                display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '4px',
                fontSize: '2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                color: remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : 'var(--accent-primary)',
            }}>
                <span>{String(mins).padStart(2, '0')}</span>
                <span style={{ opacity: 0.5 }}>:</span>
                <span>{String(secs).padStart(2, '0')}</span>
            </div>
            <div style={{
                height: 4, borderRadius: 2, background: 'var(--bg-elevated)',
                marginTop: '8px', overflow: 'hidden',
            }}>
                <div style={{
                    height: '100%', borderRadius: 2,
                    background: remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : 'var(--accent-primary)',
                    width: `${pct}%`,
                    transition: 'width 1s linear, background 0.3s ease',
                }} />
            </div>
        </div>
    );
}

export default function BookingModal({ isOpen = true, date, time, tier, price, onClose, onBooked, onNewContract }: BookingModalProps) {
    const { user } = useAuth();
    const [step, setStep] = useState<Step>('choose');
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const [loadingContracts, setLoadingContracts] = useState(true);
    const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    // Addons State
    interface Addon { key: string; name: string; price: number; description?: string | null; }
    const [availableAddons, setAvailableAddons] = useState<Addon[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);

    // Payment state (avulso)
    const [paymentType, setPaymentType] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
    const [installments, setInstallments] = useState(1);
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [bookingId, setBookingId] = useState<string | null>(null);
    // A7: cobrança dos serviços extras pagos de uma reserva por PLANO.
    const [planExtrasPaymentId, setPlanExtrasPaymentId] = useState<string | null>(null);
    const [planExtrasAmount, setPlanExtrasAmount] = useState(0);
    const bookingRef = useRef<string | null>(null);
    const paymentRef = useRef<string | null>(null); // tracks internal Payment ID for method switch
    const [holdExpiresAt, setHoldExpiresAt] = useState<string | null>(null);
    const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
    // D15: valor AUTORITATIVO da cobrança avulsa (res.paymentAmount do POST /bookings) — é o que o
    // QR/PaymentIntent cobra. Até a reserva existir, o checkout mostra a prévia local (avulsoTotal).
    const [avulsoCheckoutAmount, setAvulsoCheckoutAmount] = useState<number | null>(null);

    const endHour = parseInt(time.split(':')[0]) + 2;
    const endTime = `${endHour.toString().padStart(2, '0')}:${time.split(':')[1]}`;
    const dateDisplay = date.split('-').reverse().join('/');
    const tierUp = tier.toUpperCase();
    const totalPrice = price; // Avulso has no discount

    const [pricingConfigs, setPricingConfigs] = useState<any[]>([]);

    // Reset all state when slot changes or modal re-opens (prevents ghost 'done' screen)
    useEffect(() => {
        if (isOpen) {
            setStep('choose');
            setError('');
            setSelectedContractId(null);
            setSelectedAddons([]);
            setClientSecret(null);
            setBookingId(null);
            setPlanExtrasPaymentId(null);
            setPlanExtrasAmount(0);
            setHoldExpiresAt(null);
            setPaymentIntentId(null);
            setAvulsoCheckoutAmount(null);
            bookingRef.current = null;
            paymentRef.current = null;
        }
    }, [date, time, isOpen]);

    // Load client contracts on mount
    useEffect(() => {
        setLoadingContracts(true);
        Promise.all([
            contractsApi.getMy(),
            pricingApi.getAddons(),
            pricingApi.get()
        ]).then(([contractsRes, addonsRes, pricingRes]) => {
            setContracts(contractsRes.contracts.filter((c: any) => c.status === 'ACTIVE' && c.type !== 'AVULSO' && c.type !== 'SERVICO'));
            setAvailableAddons(addonsRes.addons.filter((a: any) => a.monthly === false));
            setPricingConfigs(pricingRes.pricing);
        }).catch(err => console.error('Failed to load modal data:', err))
          .finally(() => setLoadingContracts(false));
    }, []);

    // Check if a contract is compatible with the selected slot
    const isCompatible = (c: ContractWithStats): boolean => {
        if (c.status !== 'ACTIVE') return false;
        if (c.type === 'CUSTOM' && (c.customCreditsRemaining || 0) <= 0) return false;
        const cTier = c.tier.toUpperCase();
        const slotTier = tierUp;
        if (cTier === 'SABADO') return true;
        if (cTier === 'AUDIENCIA') return slotTier === 'COMERCIAL' || slotTier === 'AUDIENCIA';
        if (cTier === 'COMERCIAL') return slotTier === 'COMERCIAL';
        return cTier === slotTier;
    };

    /**
     * Sessões do plano já usadas. AUDFIN-05: no FIXO, a conta do servidor (planSessionsUsed — a mesma do POST /bookings:
     * Reservado conta, a sessão EXTRA não); sem o campo (resposta antiga), a conta de antes.
     */
    const planUsed = (c: ContractWithStats): number =>
        c.type === 'FIXO' && c.planSessionsUsed != null ? c.planSessionsUsed : c.completedBookings;

    const hasCredits = (c: ContractWithStats): boolean => {
        if (c.type === 'CUSTOM') return (c.customCreditsRemaining || 0) > 0;
        return planUsed(c) < c.totalBookings;
    };

    const compatibleContracts = contracts.filter(c => isCompatible(c) && hasCredits(c));
    const incompatibleContracts = contracts.filter(c => !isCompatible(c) || !hasCredits(c));
    const hasCompatible = compatibleContracts.length > 0;

    const dynamicTierConfig = pricingConfigs.find((p: any) => p.tier === tierUp);
    const dynamicTierLabel = dynamicTierConfig?.label || TIER_LABELS[tierUp] || tier;
    /** Nome legível da faixa de um contrato (o configurado pelo admin ou "Audiência"/"Sábado") — nunca a chave crua. */
    const contractTierLabel = (t: string) => {
        const key = (t || '').toUpperCase();
        return pricingConfigs.find((p: any) => p.tier === key)?.label || getMeta(TIER_META, key).label;
    };
    // We already get 'price' from props, but just in case, fall back to dynamicTierConfig?.price
    const avulsoPrice = price || dynamicTierConfig?.price || 0;

    // Compute extra cost
    const selectedContract = contracts.find(c => c.id === selectedContractId);
    const discountPct = selectedContract ? selectedContract.discountPct : 0;
    const addonsRawCost = selectedAddons.reduce((acc, key) => {
        const ad = availableAddons.find(a => a.key === key);
        return acc + (ad ? ad.price : 0);
    }, 0);
    const addonsCost = addonsRawCost * (1 - (discountPct / 100));
    const avulsoTotal = avulsoPrice + addonsRawCost; // No discount for avulso
    // Plan path: offer only EXTRA per-episode services NOT already included by the contract
    // (the contract's recurring services already accompany every recording / billed monthly).
    const planExtraAddons = availableAddons.filter(a => !(selectedContract?.addOns || []).includes(a.key));

    // Handle booking with a contract (use plan)
    const handleUsePlan = async () => {
        setLoading(true);
        setError('');
        setStep('processing');
        try {
            const res = await bookingsApi.create({ date, startTime: time, contractId: selectedContractId!, addOns: selectedAddons });
            // A7: se a reserva por plano tiver serviços EXTRAS pagos (não inclusos no contrato), o backend
            // cria um Payment PENDING e retorna paymentId/paymentAmount — roteamos para o checkout para
            // cobrá-los (senão ficam pendentes em "Meus Pagamentos", nunca entregues de graça).
            if (res.paymentId && (res.paymentAmount ?? 0) > 0) {
                bookingRef.current = res.booking.id;
                setBookingId(res.booking.id);
                paymentRef.current = res.paymentId;
                setPlanExtrasPaymentId(res.paymentId);
                setPlanExtrasAmount(res.paymentAmount ?? Math.round(addonsCost));
                setStep('plan_extras_checkout');
            } else {
                setStep('done');
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao agendar');
            setStep('error');
        } finally {
            setLoading(false);
        }
    };





    // Hold expired
    const handleHoldExpired = useCallback(() => {
        setError('⏰ Sua reserva temporária expirou. O horário foi liberado.');
        setStep('error');
    }, []);

    const handleNewContract = () => {
        onClose();
        if (onNewContract) onNewContract(date, time, tierUp);
    };

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Agendamento">
            <div className="booking-modal-content" style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

                {/* ══════════ Step: CHOOSE ══════════ */}
                {step === 'choose' && (
                    <>
                        {/* Header */}
                        <div style={{
                            textAlign: 'center', padding: '20px 0 16px',
                            borderBottom: '1px solid var(--border-subtle)', marginBottom: '20px'
                        }}>
                            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                Novo Agendamento
                            </div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>
                                📅 {dateDisplay} às {time}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                                <span className={`badge badge-${tier.toLowerCase()}`}>{dynamicTierLabel}</span>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>· {time} — {endTime}</span>
                            </div>
                        </div>

                        {/* Contract Analysis */}
                        {loadingContracts ? (
                            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                                ⏳ Verificando seus contratos...
                            </div>
                        ) : contracts.length > 0 ? (
                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                    Seus Contratos Ativos
                                </div>
                                {compatibleContracts.map(c => (
                                    <div key={c.id}
                                        onClick={() => setSelectedContractId(selectedContractId === c.id ? null : c.id)}
                                        style={{
                                            padding: '14px 16px', borderRadius: 'var(--radius-md)', marginBottom: '8px', cursor: 'pointer',
                                            background: selectedContractId === c.id ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.04)',
                                            border: `2px solid ${selectedContractId === c.id ? '#22c55e' : 'rgba(34, 197, 94, 0.2)'}`,
                                            transition: 'all 0.2s ease',
                                        }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#22c55e' }}>
                                                    ✅ {c.type === 'CUSTOM' ? '🎨 Personalizado' : c.type === 'FIXO' ? '📌 Fixo' : c.type === 'AVULSO' ? '🛒 Avulso' : '🔄 Flex'} — {contractTierLabel(c.tier)} ({c.durationMonths}m)
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                    {c.type === 'CUSTOM'
                                                        ? `Saldo: ${c.customCreditsRemaining} reagendamento(s) livre(s)`
                                                        : `Saldo: ${c.totalBookings - planUsed(c)} gravações disponíveis de ${c.totalBookings}`
                                                    }
                                                </div>
                                            </div>
                                            <div style={{
                                                width: 22, height: 22, borderRadius: '50%',
                                                border: `2px solid ${selectedContractId === c.id ? '#22c55e' : 'var(--border-default)'}`,
                                                background: selectedContractId === c.id ? '#22c55e' : 'transparent',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                transition: 'all 0.2s',
                                            }}>
                                                {selectedContractId === c.id && <span style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 800 }}>✓</span>}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {incompatibleContracts.map(c => (
                                    <div key={c.id} style={{
                                        padding: '14px 16px', borderRadius: 'var(--radius-md)', marginBottom: '8px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
                                        opacity: 0.5, cursor: 'not-allowed',
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                                    {c.type === 'CUSTOM' ? '🎨 Personalizado' : c.type === 'FIXO' ? '📌 Fixo' : c.type === 'AVULSO' ? '🛒 Avulso' : '🔄 Flex'} — {contractTierLabel(c.tier)} ({c.durationMonths}m)
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                    {!hasCredits(c)
                                                        ? (c.type === 'CUSTOM' ? 'ℹ️ Todas as sessões já estão agendadas' : '⚠️ Sem créditos restantes')
                                                        : `⚠️ Incompatível com o horário (${dynamicTierLabel})`
                                                    }
                                                </div>
                                            </div>
                                            <span style={{ fontSize: '1rem' }}>🚫</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{
                                padding: '16px', borderRadius: 'var(--radius-md)',
                                background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)',
                                fontSize: '0.8125rem', color: 'var(--tier-audiencia)',
                                marginBottom: '20px', textAlign: 'center',
                            }}>
                                ℹ️ Você não possui contratos ativos. Agende como avulso ou crie um novo contrato!
                            </div>
                        )}

                        {/* Per-episode services for the plan booking — inherit the contract discount */}
                        {selectedContractId && hasCompatible && planExtraAddons.length > 0 && (
                            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px', marginBottom: '4px' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                    Serviços desta gravação
                                </div>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 10px' }}>
                                    Opcional{discountPct > 0 ? ` · herdam ${discountPct}% de desconto do seu plano` : ''}.
                                </p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {planExtraAddons.map(addon => {
                                        const isSelected = selectedAddons.includes(addon.key);
                                        return (
                                            <ServiceLineItem
                                                key={addon.key}
                                                name={addon.name}
                                                description={addon.description}
                                                perRecordingCents={Math.round(addon.price * (1 - discountPct / 100))}
                                                selected={isSelected}
                                                onToggle={() => setSelectedAddons(prev => isSelected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                O que deseja fazer?
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {/* ignoreMultiClick: o 2º clique de um clique duplo não dispara outra reserva. */}
                                <button key="choose-plan" type="button" className="btn btn-primary" onClick={ignoreMultiClick(handleUsePlan)}
                                    disabled={!hasCompatible || !selectedContractId}
                                    style={{
                                        width: '100%', padding: '14px 20px', fontSize: '0.9375rem',
                                        opacity: hasCompatible ? 1 : 0.4,
                                        display: 'flex', justifyContent: 'center', gap: '10px'
                                    }}>
                                    {hasCompatible
                                        ? (selectedContractId ? `✅ Usar Plano Ativo ${addonsCost > 0 ? `| Pagar ${formatBRL(addonsCost)} extras` : ''}` : '☝️ Selecione um contrato acima')
                                        : '🔒 Usar Plano Ativo (sem contrato compatível)'}
                                </button>

                                <button key="choose-avulso" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(() => setTimeout(() => setStep('avulso_addons'), 0))}
                                    style={{ width: '100%', padding: '12px 20px', fontSize: '0.875rem' }}>
                                    💳 Contratar Avulso — {formatBRL(avulsoPrice)}
                                </button>

                                <button key="choose-new-contract" type="button" className="btn btn-ghost" onClick={ignoreMultiClick(handleNewContract)}
                                    style={{
                                        width: '100%', padding: '12px 20px', fontSize: '0.875rem',
                                        border: '1px dashed var(--accent-primary)', color: 'var(--accent-primary)',
                                        background: !hasCompatible ? 'rgba(139, 92, 246, 0.06)' : 'transparent',
                                    }}>
                                    ✨ Criar Novo Contrato
                                    <span style={{ fontSize: '0.6875rem', display: 'block', marginTop: '2px', opacity: 0.8 }}>
                                        Economize até 40% em relação ao avulso
                                    </span>
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {/* ══════════ Step: AVULSO ADDONS ══════════ */}
                {step === 'avulso_addons' && (
                    <>
                        <div style={{
                            textAlign: 'center', padding: '20px 0 16px',
                            borderBottom: '1px solid var(--border-subtle)', marginBottom: '20px'
                        }}>
                            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                Personalizar Agendamento
                            </div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>
                                📅 {dateDisplay} às {time}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                                <span className={`badge badge-${tier.toLowerCase()}`}>{dynamicTierLabel}</span>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>· {time} — {endTime}</span>
                            </div>
                        </div>

                        <div style={{
                            display: 'flex', justifyContent: 'space-between',
                            padding: '14px 16px', background: 'var(--bg-secondary)',
                            borderRadius: 'var(--radius-md)', marginBottom: '16px'
                        }}>
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                Valor do Agendamento (Base)
                            </span>
                            <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                                {formatBRL(avulsoPrice)}
                            </span>
                        </div>

                        {availableAddons.length > 0 ? (
                            <div style={{ marginBottom: '24px' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                    Incluir Serviços Extras
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px' }}>
                                    {availableAddons.map(addon => {
                                        const isSelected = selectedAddons.includes(addon.key);
                                        return (
                                            <ServiceLineItem
                                                key={addon.key}
                                                name={addon.name}
                                                description={addon.description}
                                                perRecordingCents={addon.price}
                                                selected={isSelected}
                                                onToggle={() => setSelectedAddons(prev => isSelected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                                Nenhum serviço adicional disponível no momento.
                            </div>
                        )}

                        <div className="modal-actions" style={{ marginTop: '24px', display: 'flex', gap: '10px' }}>
                            <button key="addons-back" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(() => setStep('choose'))} style={{ flex: 1 }}>Voltar</button>
                            <button key="addons-next" type="button" className="btn btn-primary" onClick={ignoreMultiClick(() => setTimeout(() => setStep('avulso_checkout'), 0))} style={{ flex: 2 }}>
                                Continuar — {formatBRL(avulsoTotal)}
                            </button>
                        </div>
                    </>
                )}

                {/* ══════════ Step: AVULSO CHECKOUT (Unified InlineCheckout) ══════════ */}
                {step === 'avulso_checkout' && (
                    <>
                        <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: '0 0 16px 0' }}>Pagamento Avulso</h2>
                        <div style={{
                            padding: '14px 16px', borderRadius: 'var(--radius-md)',
                            background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)',
                            fontSize: '0.8125rem', color: 'var(--tier-audiencia)',
                            marginBottom: '16px',
                        }}>
                            ⚠️ Este agendamento <strong>não está coberto</strong> por nenhum plano ativo.
                            Ao pagar, o horário será <strong>confirmado imediatamente</strong>.
                        </div>

                        {error && (
                            <div style={{
                                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                                background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)',
                                fontSize: '0.8125rem', color: 'var(--danger, #ef4444)', marginBottom: '12px',
                            }}>
                                {error}
                            </div>
                        )}

                        <InlineCheckout
                            amount={avulsoCheckoutAmount ?? avulsoTotal}
                            description={`Avulso ${dateDisplay} às ${time}`}
                            allowedMethods={['CARTAO', 'PIX']}
                            context="avulso"
                            createPaymentFn={async (method) => {
                                // D15: aqui só se cria a reserva (hold) na 1ª escolha de método. A cobrança
                                // em si — PIX (QR + validade, reaproveitando a viva) ou o PaymentIntent do
                                // cartão com as parcelas — é emitida pelo InlineCheckout via
                                // POST /stripe/create-payment a partir do paymentId (fonte única). Por isso
                                // não repassamos pixString/QR. Trocar de método reaproveita o mesmo Payment.
                                if (paymentRef.current) return { paymentId: paymentRef.current };

                                const res = await bookingsApi.create(method === 'CARTAO'
                                    ? { date, startTime: time, addOns: selectedAddons, paymentMethod: 'CARTAO', installments: 1, paymentType: 'CREDIT' }
                                    : { date, startTime: time, addOns: selectedAddons, paymentMethod: 'PIX' });
                                bookingRef.current = res.booking.id;
                                setBookingId(res.booking.id);
                                setHoldExpiresAt(res.booking.holdExpiresAt || null);
                                if (typeof res.paymentAmount === 'number') setAvulsoCheckoutAmount(res.paymentAmount);
                                const pid = res.paymentId || res.booking.id;
                                paymentRef.current = pid;
                                return { paymentId: pid };
                            }}
                            onSuccess={async () => {
                                if (bookingId) {
                                    try {
                                        await bookingsApi.completePayment(bookingId, {});
                                    } catch { /* non-blocking */ }
                                }
                                setStep('done');
                            }}
                            onError={(msg) => setError(msg)}
                            onCancel={() => setStep('avulso_addons')}
                        />
                    </>
                )}

                {/* ══════════ Step: PLAN EXTRAS CHECKOUT (serviços extras de reserva por plano — A7) ══════════ */}
                {step === 'plan_extras_checkout' && planExtrasPaymentId && (
                    <>
                        <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: '0 0 16px 0' }}>Serviços extras</h2>
                        <div style={{
                            padding: '14px 16px', borderRadius: 'var(--radius-md)',
                            background: 'rgba(17,129,155,0.08)', border: '1px solid rgba(17,129,155,0.2)',
                            fontSize: '0.8125rem', color: 'var(--accent-text)', marginBottom: '16px',
                        }}>
                            ✅ Sua gravação foi <strong>reservada</strong>. Conclua o pagamento dos serviços extras para ativá-los nesta gravação.
                        </div>

                        {error && (
                            <div style={{
                                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                                background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)',
                                fontSize: '0.8125rem', color: 'var(--danger, #ef4444)', marginBottom: '12px',
                            }}>
                                {error}
                            </div>
                        )}

                        <InlineCheckout
                            amount={planExtrasAmount}
                            description={`Serviços extras — ${dateDisplay} às ${time}`}
                            allowedMethods={['CARTAO', 'PIX']}
                            context="avulso"
                            // O Payment dos extras já existe (criado na reserva por plano): o InlineCheckout
                            // emite a cobrança (PIX ou cartão) a partir do paymentId — D15, fonte única.
                            paymentId={planExtrasPaymentId}
                            onSuccess={() => setStep('done')}
                            onError={(msg) => setError(msg)}
                            onCancel={() => setStep('done')}
                        />
                    </>
                )}

                {/* ══════════ Step: HELD (retry after failure) ══════════ */}
                {step === 'held' && holdExpiresAt && (
                    <div style={{ padding: '20px 0' }}>
                        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
                            <h3 style={{ fontSize: '1.125rem', marginBottom: '8px' }}>Cartão Recusado</h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginBottom: '16px' }}>
                                {error || 'O pagamento não foi processado. Seu horário ainda está reservado temporariamente.'}
                            </p>
                        </div>

                        <CountdownTimer expiresAt={holdExpiresAt} onExpire={handleHoldExpired} />

                        <div style={{
                            padding: '12px 16px', borderRadius: 'var(--radius-md)',
                            background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)',
                            fontSize: '0.8125rem', color: 'var(--tier-audiencia)',
                            textAlign: 'center', marginBottom: '20px',
                        }}>
                            ⏰ Seu horário está reservado temporariamente. Complete o pagamento antes do timer zerar.
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <button key="held-retry" type="button" className="btn btn-primary" onClick={ignoreMultiClick(() => setTimeout(() => setStep('avulso_checkout'), 0))}
                                style={{ width: '100%' }}>
                                💳 Tentar Outro Cartão
                            </button>
                            <button key="held-cancel" type="button" className="btn btn-ghost btn-sm" onClick={ignoreMultiClick(onClose)}
                                style={{ width: '100%', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Cancelar Reserva
                            </button>
                        </div>
                    </div>
                )}

                {/* Processing */}
                {step === 'processing' && (
                    <div style={{ textAlign: 'center', padding: '40px 0' }}>
                        <BrandLoader size="compact" label="Processando seu agendamento…" />
                    </div>
                )}

                {/* Done */}
                {step === 'done' && (
                    <>
                        <PaymentSuccess
                            title="Agendamento confirmado!"
                            subtitle={<>{dateDisplay} das {time} às {endTime}</>}
                        />
                        <div className="modal-actions" style={{ justifyContent: 'center', marginTop: 20 }}>
                            <button key="done" type="button" className="btn btn-primary" onClick={ignoreMultiClick(onBooked)}>Concluir</button>
                        </div>
                    </>
                )}

                {/* Error */}
                {step === 'error' && (
                    <>
                        <div style={{ textAlign: 'center', padding: '12px 4px 4px' }}>
                            <div style={{
                                width: 72, height: 72, borderRadius: '50%', margin: '0 auto 18px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                            }}>
                                <XCircle size={40} strokeWidth={2} />
                            </div>
                            <h2 style={{ fontSize: '1.15rem', fontWeight: 800, margin: '0 0 8px', color: 'var(--text-primary)' }}>Ops!</h2>
                            <div className="error-message">{error}</div>
                        </div>
                        <div className="modal-actions" style={{ justifyContent: 'center' }}>
                            <button key="error-retry" type="button" className="btn btn-secondary" onClick={ignoreMultiClick(() => setStep('choose'))}>Tentar Novamente</button>
                        </div>
                    </>
                )}
            </div>
        </BottomSheetModal>
    );
}
