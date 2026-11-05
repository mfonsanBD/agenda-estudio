import { useState, useEffect } from 'react';
import { UserDetail } from '../../../api/client';
import { UserRound, Mail, Phone, IdCard, UserX } from 'lucide-react';
import { maskPhone } from '../../../utils/mask';

/** Cabeçalho do perfil do cliente: foto (com fallback p/ iniciais), nome,
 *  contatos e badges de papel/status/tags. Cliente EXCLUÍDO (D3, `deletedAt`): os dados
 *  pessoais vêm null (anonimizados) — mostra "Dados pessoais removidos" e o selo "Excluído". */
export default function ProfileHeader({ user }: { user: UserDetail }) {
    const isDeleted = !!user.deletedAt;
    // Foto de upload pode ter sumido do disco (uploads efêmeros) — cai nas iniciais.
    const [photoError, setPhotoError] = useState(false);
    useEffect(() => { setPhotoError(false); }, [user.photoUrl]);

    return (
        <div className="card" style={{ padding: '24px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                {user.photoUrl && !photoError ? (
                    <img src={user.photoUrl} alt={user.name}
                        onError={() => setPhotoError(true)}
                        style={{
                            width: 64, height: 64, borderRadius: '50%', objectFit: 'cover',
                            border: '2px solid var(--accent-primary)',
                        }} />
                ) : (
                <div style={{
                    width: 64, height: 64, borderRadius: '50%',
                    background: 'linear-gradient(135deg, var(--accent-primary), #0e6b7a)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.5rem', fontWeight: 700, color: '#fff',
                }}>
                    {user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{user.name}</h1>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', color: 'var(--text-secondary)', fontSize: '0.8125rem', marginTop: '6px' }}>
                        {isDeleted ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                                <UserX size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
                                Dados pessoais removidos na exclusão
                            </span>
                        ) : (<>
                        {user.email ? (
                            <a href={`mailto:${user.email}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
                                <Mail size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</span>
                            </a>
                        ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <Mail size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                Sem e-mail
                            </span>
                        )}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Phone size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                            {user.phone ? maskPhone(user.phone) : 'Sem telefone'}
                        </span>
                        {user.cpfCnpj && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <IdCard size={14} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                <span style={{ fontFamily: 'monospace' }}>{user.cpfCnpj}</span>
                            </span>
                        )}
                        </>)}
                    </div>
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {/* /api/users/:id só abre CLIENTE (D1): a equipe vive na tela Equipe. */}
                        <span className="badge badge-comercial" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <UserRound size={12} aria-hidden="true" /> Cliente
                        </span>
                        {isDeleted ? (
                            <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <UserX size={12} aria-hidden="true" /> Excluído
                            </span>
                        ) : (
                        <span className="badge" style={{
                            background: user.clientStatus === 'ACTIVE' ? 'rgba(16,185,129,0.15)' : user.clientStatus === 'BLOCKED' ? 'rgba(220,38,38,0.15)' : 'rgba(107,114,128,0.15)',
                            color: user.clientStatus === 'ACTIVE' ? 'var(--success)' : user.clientStatus === 'BLOCKED' ? 'var(--danger)' : 'var(--neutral)',
                        }}>
                            {user.clientStatus === 'ACTIVE' ? '● Ativo' : user.clientStatus === 'BLOCKED' ? '● Bloqueado' : '● Inativo'}
                        </span>
                        )}
                        {user.tags?.map((t: string) => (
                            <span key={t} style={{
                                fontSize: '0.6875rem', padding: '2px 8px', borderRadius: '999px',
                                background: 'rgba(17,129,155,0.15)', color: 'var(--accent-text)',
                            }}>#{t}</span>
                        ))}
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                            Cadastro: {new Date(user.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
