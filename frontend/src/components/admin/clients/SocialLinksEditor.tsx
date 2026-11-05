import { useState, useEffect } from 'react';
import { usersApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';

const SAVE_ERROR = { message: 'Não foi possível salvar. Tente novamente.', type: 'error' as const };

/** Chaves das redes sociais gravadas no JSON do campo `socialLinks` do perfil. */
export type SocialNetworkKey = 'youtube' | 'instagram' | 'spotify' | 'website';

/** Redes sociais do perfil do cliente (mesma lista do editor inline e dos modais de cliente). */
export const SOCIAL_NETWORKS: ReadonlyArray<{ key: SocialNetworkKey; label: string; icon: string }> = [
    { key: 'youtube', label: 'YouTube', icon: '📺' },
    { key: 'instagram', label: 'Instagram', icon: '📷' },
    { key: 'spotify', label: 'Spotify', icon: '🎧' },
    { key: 'website', label: 'Site', icon: '🌐' },
];

/**
 * Lê o campo `socialLinks` (JSON `{youtube, instagram, spotify, website, …}`). Texto que não é
 * um objeto JSON (ex.: texto livre antigo) vira `{}`; só valores texto são mantidos.
 * Chaves fora da lista (ex.: `linkedin`, gravado pelo perfil do próprio cliente) são preservadas.
 */
export function parseSocialLinks(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const obj: unknown = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch { return {}; }
}

/** Serializa para o campo `socialLinks`: descarta os vazios; nada preenchido = `null`. */
export function serializeSocialLinks(links: Record<string, string>): string | null {
    const clean = Object.fromEntries(Object.entries(links).filter(([, v]) => v.trim()));
    return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

interface SocialLinksEditorProps {
    socialLinks: string | null;
    userId: string;
    onSaved: () => void;
    /** Somente leitura: só os links, sem edição. */
    readOnly?: boolean;
}

/** Editor de redes sociais (JSON serializado no campo socialLinks). */
export default function SocialLinksEditor({ socialLinks, userId, onSaved, readOnly = false }: SocialLinksEditorProps) {
    const parsed: Record<string, string> = parseSocialLinks(socialLinks);
    const [editing, setEditing] = useState(false);
    const [links, setLinks] = useState(parsed);
    useEffect(() => { setLinks(parseSocialLinks(socialLinks)); }, [socialLinks]);
    const { showToast } = useUI();
    const save = async () => {
        setEditing(false);
        try { await usersApi.update(userId, { socialLinks: serializeSocialLinks(links) } as any); onSaved(); } catch { showToast(SAVE_ERROR); }
    };
    const socials = SOCIAL_NETWORKS;
    return (
        <div style={{ gridColumn: 'span 2' }}>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Redes Sociais</div>
            {readOnly ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', minHeight: '32px', alignItems: 'center', padding: '6px 8px' }}>
                    {Object.entries(parsed).length > 0 ? Object.entries(parsed).map(([k, v]) => (
                        <a key={k} href={v} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--accent-text)', textDecoration: 'underline' }}>
                            {socials.find(s => s.key === k)?.icon} {socials.find(s => s.key === k)?.label || k}
                        </a>
                    )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>—</span>}
                </div>
            ) : editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '6px' }}>
                    {socials.map(s => (
                        <input key={s.key} className="form-input" placeholder={`${s.icon} ${s.label}`} value={links[s.key] || ''}
                            onChange={e => setLinks({ ...links, [s.key]: e.target.value })}
                            style={{ fontSize: '0.75rem', padding: '6px 8px' }} />
                    ))}
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn btn-primary btn-sm" onClick={save}>Salvar</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setLinks(parsed); }}>Cancelar</button>
                    </div>
                </div>
            ) : (
                <div role="button" tabIndex={0} aria-label="Editar redes sociais"
                    onClick={() => setEditing(true)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
                    style={{ cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: '8px', minHeight: '32px', alignItems: 'center', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-color)' }}>
                    {Object.entries(parsed).length > 0 ? Object.entries(parsed).map(([k, v]) => (
                        <a key={k} href={v} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: '0.75rem', color: 'var(--accent-text)', textDecoration: 'underline' }}>
                            {socials.find(s => s.key === k)?.icon} {socials.find(s => s.key === k)?.label || k}
                        </a>
                    )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>Clique para adicionar</span>}
                </div>
            )}
        </div>
    );
}
