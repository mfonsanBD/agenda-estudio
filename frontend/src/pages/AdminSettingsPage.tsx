import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    Settings,
    Building2,
    Clock,
    Wallet,
    ScrollText,
    Sparkles,
    CreditCard,
    Plug,
    Cloud,
    Clapperboard,
    Mail,
    ChevronLeft,
    ChevronRight,
    Lock,
    type LucideIcon,
} from 'lucide-react';
import { useDragScroll } from '../hooks/useDragScroll';
import { usePermission } from '../hooks/usePermission';
import { SETTINGS_SECTION_PERMISSIONS } from '../constants/permissions';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import Tooltip from '../components/ui/Tooltip';
import SettingsBusinessConfigSection from '../components/admin/settings/SettingsBusinessConfigSection';
import SettingsTiersSection from '../components/admin/settings/SettingsTiersSection';
import SettingsPaymentMethodsSection from '../components/admin/settings/SettingsPaymentMethodsSection';
import SettingsServicesSection from '../components/admin/settings/SettingsServicesSection';
import SettingsEmailSection from '../components/admin/settings/SettingsEmailSection';
import IntegrationSettings from '../components/IntegrationSettings';

type SectionId =
    | 'gerais'
    | 'horarios'
    | 'financeiro'
    | 'politicas'
    | 'servicos'
    | 'pagamentos'
    | 'ambiente'
    | 'gravacoes'
    | 'email'
    | 'integracoes';

/** O que o acesso de quem está vendo libera DENTRO de uma seção (hoje: as taxas de gateway de Preços e regras). */
interface SectionContext {
    /** Taxas de gateway (grupo `gateway` + histórico): exclusivas do ADMIN (`config.taxas`). */
    canEditGatewayFees: boolean;
}

interface SectionDef {
    id: SectionId;
    label: string;
    icon: LucideIcon;
    render: (ctx: SectionContext) => React.ReactNode;
}

/**
 * Each section is fully self-contained (owns its own fetch + dirty flag +
 * save bar). Switching sections unmounts the previous one — there is no
 * shared cross-section state, mirroring the legacy per-tab behavior.
 *
 * Equipe (D2): cada seção abre com a sua chave (`SETTINGS_SECTION_PERMISSIONS`: config.gerais, …); a
 * página lista só as permitidas. E-mail, Integrações e as Taxas de gateway são exclusivas do ADMIN — o
 * colaborador vê as taxas em cinza, "só o administrador", dentro de Preços e regras.
 */
const SECTIONS: SectionDef[] = [
    {
        id: 'gerais',
        label: 'Gerais',
        icon: Building2,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['studio']}
                title="Estúdio & Branding"
                subtitle="Nome, logo, e-mail e imagens do estúdio."
            />
        ),
    },
    {
        id: 'horarios',
        label: 'Horários & Grade',
        icon: Clock,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['schedule']}
                title="Horários & Grade"
                subtitle="Slots de atendimento, dias de funcionamento e duração dos blocos."
            />
        ),
    },
    {
        id: 'financeiro',
        // EQ-REQ-03: o nome do catálogo (config.precos) — "Financeiro" confundia com o módulo "Financeiro e receita".
        label: 'Preços e regras',
        icon: Wallet,
        render: ({ canEditGatewayFees }) => (
            <div style={{ display: 'grid', gap: '32px' }}>
                <SettingsTiersSection />
                {canEditGatewayFees ? (
                    <SettingsBusinessConfigSection
                        groups={['plans', 'gateway', 'payments']}
                        title="Planos, Taxas & Gateway"
                        subtitle="Descontos por fidelidade, taxas de cartão/PIX e taxas de gateway."
                        stackedSaveBar
                    />
                ) : (
                    // Colaborador com "Preços e regras": sem o grupo gateway (o servidor nem o envia);
                    // as taxas aparecem em cinza, "só o administrador".
                    <SettingsBusinessConfigSection
                        groups={['plans', 'payments']}
                        adminOnlyGroups={['gateway']}
                        title="Planos & Taxas"
                        subtitle="Descontos por fidelidade e taxas de cartão/PIX."
                        stackedSaveBar
                    />
                )}
            </div>
        ),
    },
    {
        id: 'politicas',
        label: 'Políticas',
        icon: ScrollText,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['policies']}
                title="Políticas Operacionais"
                subtitle="Janelas de tempo, multas e restrições de agendamento."
            />
        ),
    },
    {
        id: 'servicos',
        label: 'Serviços',
        icon: Sparkles,
        render: () => <SettingsServicesSection />,
    },
    {
        id: 'pagamentos',
        label: 'Formas de pagamento',
        icon: CreditCard,
        render: () => <SettingsPaymentMethodsSection />,
    },
    {
        id: 'ambiente',
        label: 'Ambiente',
        icon: Cloud,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['ambient']}
                title="Ambiente do Hero"
                subtitle="Animação por aba + clima/dia-noite no topo das telas do cliente. Defina a cidade do clima."
            />
        ),
    },
    {
        id: 'gravacoes',
        label: 'Gravações',
        icon: Clapperboard,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['recordings']}
                title="Gravações & Transmissão"
                subtitle="Habilite ou desabilite as plataformas de transmissão oferecidas ao cliente."
            />
        ),
    },
    {
        id: 'email',
        label: 'E-mail',
        icon: Mail,
        render: () => <SettingsEmailSection />,
    },
    {
        id: 'integracoes',
        label: 'Integrações',
        icon: Plug,
        render: () => <IntegrationSettings />,
    },
];

const DEFAULT_SECTION: SectionId = 'gerais';

export default function AdminSettingsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const { ref: railRef, showLeft, showRight, scrollByPage } = useDragScroll<HTMLElement>();
    const { can, isAdmin } = usePermission();

    // Só as seções que o acesso libera (o SettingsSectionGuard do App já tira a pessoa de ?sec= proibido;
    // aqui a trilha e o conteúdo também não mostram o que ela não abre).
    const sections = useMemo(() => SECTIONS.filter(s => can(SETTINGS_SECTION_PERMISSIONS[s.id])), [can]);
    const ctx: SectionContext = { canEditGatewayFees: can('config.taxas') };

    const activeId: SectionId | null = useMemo(() => {
        const sec = searchParams.get('sec') as SectionId | null;
        if (sec && sections.some(s => s.id === sec)) return sec;
        if (sections.some(s => s.id === DEFAULT_SECTION)) return DEFAULT_SECTION;
        return sections[0]?.id ?? null;
    }, [searchParams, sections]);

    const active = sections.find(s => s.id === activeId) ?? sections[0] ?? null;

    const goToSection = (id: SectionId) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('sec', id);
            return next;
        });
    };

    return (
        <div>
            <AdminPageHeader
                icon={Settings}
                title="Configurações"
                subtitle="Ajustes do sistema do estúdio"
            />

            <div className="admin-settings">
                {/* ── Sub-nav: hidden on desktop (driven by the sidebar's expandable
                       "Configurações"); shown as scrollable pills on mobile (sidebar hidden).
                       Wrapper hosts the side arrows + drag-to-scroll affordances. ── */}
                <div className="admin-settings-rail-wrap scrollrow-wrap">
                    {showLeft && (
                        <Tooltip content="Ver seções anteriores" describe={false}>
                            <button
                                type="button"
                                className="scrollrow-arrow scrollrow-arrow--left"
                                aria-label="Ver seções anteriores"
                                onClick={() => scrollByPage(-1)}
                                tabIndex={-1}
                            >
                                <ChevronLeft size={16} aria-hidden="true" />
                            </button>
                        </Tooltip>
                    )}
                    <nav
                        ref={railRef}
                        className="admin-settings-rail admin-settings-rail--mobile-only scrollrow-track"
                        aria-label="Seções de configurações"
                    >
                        {sections.map(section => {
                            const Icon = section.icon;
                            const isActive = section.id === activeId;
                            return (
                                <button
                                    key={section.id}
                                    type="button"
                                    className={`admin-settings-rail-item ${isActive ? 'admin-settings-rail-item--active' : ''}`}
                                    aria-current={isActive ? 'page' : undefined}
                                    onClick={() => goToSection(section.id)}
                                >
                                    <span className="admin-settings-rail-icon">
                                        <Icon size={18} strokeWidth={1.8} />
                                    </span>
                                    {section.label}
                                </button>
                            );
                        })}
                    </nav>
                    {showRight && (
                        <Tooltip content="Ver mais seções" describe={false}>
                            <button
                                type="button"
                                className="scrollrow-arrow scrollrow-arrow--right scrollrow-arrow--pulse"
                                aria-label="Ver mais seções"
                                onClick={() => scrollByPage(1)}
                                tabIndex={-1}
                            >
                                <ChevronRight size={16} aria-hidden="true" />
                            </button>
                        </Tooltip>
                    )}
                </div>

                {/* ── Active section only ── */}
                <div className="admin-settings-panel">
                    {active
                        ? active.render(ctx)
                        : (
                            <div style={{ padding: 24, borderRadius: 16, textAlign: 'center', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                Seu acesso não libera nenhuma seção das Configurações. Fale com o administrador.
                            </div>
                        )}
                    {/* Colaborador: o que é exclusivo do administrador aparece em cinza, para ninguém procurar
                        (as Taxas de gateway aparecem em cinza dentro da própria seção Preços e regras). */}
                    {!isAdmin && (
                        <p role="note" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '28px 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            <Lock size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
                            <span>E-mail (SMTP) e Integrações (Stripe, Sicoob e Cora): só o administrador.</span>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
