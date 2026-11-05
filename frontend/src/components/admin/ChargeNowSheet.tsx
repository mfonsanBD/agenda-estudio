import BottomSheetModal from '../BottomSheetModal';
import InlineCheckout from '../InlineCheckout';
import { ignoreMultiClick } from '../../hooks/useWizardStep';
import { usePermission } from '../../hooks/usePermission';

type ChargeMethod = 'CARTAO' | 'PIX' | 'BOLETO';

interface ChargeNowSheetProps {
    paymentId: string;
    /** Valor em centavos, já com cupom aplicado quando houver. */
    amount: number;
    description: string;
    title: string;
    subtitle: string;
    /**
     * Opcional — restringe as abas. Padrão (E1): PIX + Cartão sempre, e Boleto quando disponível (E3:
     * chave-mestra "Aceitar pagamento por boleto" + Cora) em TODA cobrança feita pelo admin — de contrato
     * ou avulsa. Dentro de Cartão o checkout já oferece Crédito | Débito.
     */
    allowedMethods?: ChargeMethod[];
    /** Aba aberta primeiro — a forma escolhida no wizard. Ignorada se não estiver disponível. */
    initialMethod?: ChargeMethod | null;
    /** @deprecated E3 — IGNORADO: o boleto segue só a chave-mestra das Configurações (não há mais liberação por contrato). */
    allowBoleto?: boolean;
    context: 'avulso' | 'contract';
    contractDuration?: number;
    /**
     * @deprecated IGNORADO — o erro aparece uma vez só, dentro do próprio checkout (que o limpa ao trocar de
     * aba). O alerta repetido aqui ficava preso sob o QR depois da troca de forma. Mantido só para os
     * chamadores compilarem.
     */
    error?: string;
    onError: (msg: string) => void;
    onSuccess: () => void;
    /** Fechar / deixar pendente (backdrop, ESC e o botão inferior). */
    onDismiss: () => void;
    dismissLabel?: string;
    /**
     * Cliente cobrado — usado para o gate/coleta de CPF do CLIENTE (PIX/Boleto), não do admin. Os
     * cartões salvos listados também são os do cliente (o checkout busca pelo pagamento).
     */
    client?: { id: string; name?: string | null; cpfCnpj?: string | null };
}

/**
 * Sheet de cobrança imediata (admin) — BottomSheetModal sm + InlineCheckout em modo admin.
 * Usado em CreateBookingModal, CreateContractModal, CustomContractFlow e no detalhe/lista de contratos.
 * Cobra o CLIENTE (payment.userId): o backend resolve o pagador a partir do payment — o CPF pedido no
 * PIX e os cartões salvos listados são os do cliente, nunca os do admin logado (E1).
 *
 * Abas: PIX | Cartão (| Boleto). O boleto é oferecido em toda cobrança do admin (E1/E3), inclusive a
 * avulsa: o `POST /bookings/admin` cria um contrato AVULSO já ATIVO e a reserva fica RESERVED sem prazo de
 * 10 minutos, então o backend aceita. Ele continua sendo a autoridade — a aba só aparece com a
 * chave-mestra + Cora e com o Boleto habilitado no contexto (`avulso`/`contract`) nas Configurações; um 400
 * BOLETO_UNAVAILABLE / BOLETO_NOT_ALLOWED_HERE tira a aba dentro do checkout.
 *
 * Erros: só dentro do InlineCheckout (uma mensagem, limpa ao trocar de aba). O `onError` segue avisando
 * o pai, mas o sheet não repete o alerta.
 *
 * Equipe (D2): cobrar exige `cobrancas.cobrar` — os chamadores só abrem o sheet com ela. Se mesmo assim
 * abrir sem a chave (permissão retirada com a tela aberta), mostra o aviso em vez de um checkout que daria
 * 403. O cartão salvo do cliente fica a cargo do InlineCheckout (`cobrancas.cartao_salvo`).
 */
export default function ChargeNowSheet({
    paymentId,
    amount,
    description,
    title,
    subtitle,
    allowedMethods,
    initialMethod,
    context,
    contractDuration,
    onError,
    onSuccess,
    onDismiss,
    dismissLabel = 'Deixar pendente (cliente paga depois)',
    client,
}: ChargeNowSheetProps) {
    const { can } = usePermission();
    const canCharge = can('cobrancas.cobrar');
    return (
        <BottomSheetModal isOpen onClose={onDismiss} hideHeader size="sm" className="admin-sheet" title={title}>
            <div style={{ padding: '24px 28px' }}>
                <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>{title}</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                    {subtitle}
                </p>
                {!canCharge ? (
                    <div className="admin-alert admin-alert--warning" role="note">
                        Você não tem a permissão “Cobrar o cliente”. A cobrança continua pendente: o cliente paga pelo app.
                    </div>
                ) : (
                <InlineCheckout
                    amount={amount}
                    paymentId={paymentId}
                    description={description}
                    contractDuration={contractDuration}
                    allowedMethods={allowedMethods}
                    initialMethod={initialMethod}
                    isAdmin
                    offerBoleto
                    context={context}
                    chargeClient={client}
                    onSuccess={onSuccess}
                    onError={onError}
                    onCancel={onDismiss}
                />
                )}
                <button key="charge-dismiss" type="button" onClick={ignoreMultiClick(onDismiss)} className="btn-admin-ghost" style={{ marginTop: 12, width: '100%' }}>
                    {dismissLabel}
                </button>
            </div>
        </BottomSheetModal>
    );
}
