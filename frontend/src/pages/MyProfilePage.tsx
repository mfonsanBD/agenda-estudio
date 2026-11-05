import { useState, useRef, useId, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';
import { maskCpfCnpj, isValidCpfCnpj } from '../utils/mask';
import HeroAmbient from '../components/client/HeroAmbient';
import ImageCropper from '../components/ImageCropper';
import Avatar from '../components/Avatar';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import AddressFields, { type AddressValues } from '../components/admin/clients/AddressFields';
import { parseSocialLinks, serializeSocialLinks } from '../components/admin/clients/SocialLinksEditor';
import { ArrowLeft, UserRound, Camera, Save, Loader2, CheckCircle2 } from 'lucide-react';
import { usePermission } from '../hooks/usePermission';

/** Senha mínima: equipe 8 (o servidor recusa menos — PASSWORD_TOO_SHORT); cliente 6. */
const STAFF_MIN_PASSWORD = 8;
const CLIENT_MIN_PASSWORD = 6;

export default function MyProfilePage() {
    const navigate = useNavigate();
    const { user, updateUser } = useAuth();
    const uid = useId();
    // Equipe (ADMIN/COLABORADOR): o perfil próprio é só nome, telefone, foto, senha e notificações — CPF,
    // endereço e redes são da ficha de CLIENTE (proposta §4.8). Senha da equipe: mínimo 8, e trocar
    // encerra as outras sessões (o servidor reemite os cookies desta).
    const { isStaff, roleLabel } = usePermission();
    const minPassword = isStaff ? STAFF_MIN_PASSWORD : CLIENT_MIN_PASSWORD;

    const [name, setName] = useState(user?.name || '');
    const [phone, setPhone] = useState(user?.phone || '');
    const [password, setPassword] = useState('');
    const [cpfCnpj, setCpfCnpj] = useState(user?.cpfCnpj ? maskCpfCnpj(user.cpfCnpj) : '');
    const [addr, setAddr] = useState<AddressValues>({
        zipCode: user?.zipCode || '', address: user?.address || '', addressNumber: user?.addressNumber || '',
        complement: user?.complement || '', neighborhood: user?.neighborhood || '', city: user?.city || '', state: user?.state || '',
    });

    // JSON do perfil (mesmo formato do admin). Texto inválido → {}.
    const savedLinks = parseSocialLinks(user?.socialLinks);
    const initialInsta = savedLinks.instagram || '';
    const initialLink = savedLinks.linkedin || '';

    const [instagram, setInstagram] = useState(initialInsta);
    const [linkedin, setLinkedin] = useState(initialLink);
    const [essentialOnly, setEssentialOnly] = useState(user?.essentialNotificationsOnly ?? false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

    const flashSuccess = (msg: string) => {
        setSuccess(msg);
        setTimeout(() => setSuccess(''), 4000);
    };

    const handleSave = async () => {
        setError(''); setSuccess('');
        if (password && password.length < minPassword) {
            setError(`A nova senha precisa de pelo menos ${minPassword} caracteres.`);
            return;
        }
        setSaving(true);
        try {
            const data: Parameters<typeof authApi.updateProfile>[0] = {};
            if (name && name !== user?.name) data.name = name;
            if (phone !== (user?.phone || '')) data.phone = phone;
            if (password) data.password = password;
            const cpfDigits = cpfCnpj.replace(/\D/g, '');
            if (!isStaff && cpfDigits !== (user?.cpfCnpj || '').replace(/\D/g, '')) {
                if (cpfDigits && !isValidCpfCnpj(cpfDigits)) {
                    setError('CPF/CNPJ inválido. Confira os números.');
                    setSaving(false);
                    return;
                }
                data.cpfCnpj = cpfDigits;
            }
            if (!isStaff) (['zipCode', 'address', 'addressNumber', 'complement', 'neighborhood', 'city', 'state'] as const).forEach(f => {
                if (addr[f] !== (user?.[f] || '')) data[f] = addr[f];
            });
            if (!isStaff && (instagram !== initialInsta || linkedin !== initialLink)) {
                // MERGE com o JSON salvo: só Instagram/LinkedIn mudam aqui; YouTube, Spotify, Site
                // (e outras chaves) definidos pelo admin são preservados. Vazio remove a chave.
                const merged = { ...parseSocialLinks(user?.socialLinks), instagram: instagram.trim(), linkedin: linkedin.trim() };
                data.socialLinks = serializeSocialLinks(merged) ?? '';
            }
            if (essentialOnly !== (user?.essentialNotificationsOnly ?? false)) {
                data.essentialNotificationsOnly = essentialOnly;
            }

            if (Object.keys(data).length > 0) {
                const res = await authApi.updateProfile(data);
                updateUser(res.user);
            }
            setPassword('');
            flashSuccess(isStaff && data.password
                ? 'Perfil atualizado. A nova senha vale a partir de agora; as suas outras sessões foram encerradas.'
                : 'Perfil atualizado com sucesso!');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro ao salvar o perfil.');
        } finally {
            setSaving(false);
        }
    };

    const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setCropImageSrc(reader.result as string);
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const handleCropConfirm = async (blob: Blob) => {
        setCropImageSrc(null);
        setUploadingPhoto(true); setError('');
        try {
            const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
            const res = await authApi.uploadPhoto(file);
            updateUser(res.user);
            flashSuccess('Foto de perfil atualizada!');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro ao enviar a foto.');
        } finally {
            setUploadingPhoto(false);
        }
    };

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="inicio" />
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)} style={{ marginBottom: 12, gap: 6 }}>
                    <ArrowLeft size={16} /> Voltar
                </button>
                <div className="client-hero__header" style={{ marginBottom: 0 }}>
                    <div className="client-hero__icon-wrapper client-hero__icon-wrapper--cyan">
                        <UserRound size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Meu Perfil</h2>
                        <p className="client-hero__message">{isStaff ? `${roleLabel} · Gerencie seus dados de acesso e preferências` : 'Gerencie seus dados e preferências'}</p>
                    </div>
                </div>
            </div>

            {cropImageSrc ? (
                <div className="profile-page-section animate-card-enter">
                    <ImageCropper imageSrc={cropImageSrc} onConfirm={handleCropConfirm} onCancel={() => setCropImageSrc(null)} />
                </div>
            ) : (
                <div className="profile-page-section animate-card-enter">
                    {/* Avatar */}
                    <div className="profile-avatar-block">
                        <Avatar
                            className="profile-avatar"
                            photoUrl={user?.photoUrl}
                            name={user?.name}
                            onClick={() => fileRef.current?.click()}
                            title="Clique para trocar a foto"
                        >
                            {uploadingPhoto && (
                                <div className="profile-avatar__overlay">
                                    <div className="spinner" style={{ width: 24, height: 24 }} />
                                </div>
                            )}
                        </Avatar>
                        <input ref={fileRef} type="file" accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
                        <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, gap: 6 }} onClick={() => fileRef.current?.click()} disabled={uploadingPhoto}>
                            <Camera size={15} /> {uploadingPhoto ? 'Enviando…' : 'Alterar foto'}
                        </button>
                    </div>

                    {error && <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>}
                    {success && (
                        <div className="login-modal-alert login-modal-alert--success" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CheckCircle2 size={16} /> {success}
                        </div>
                    )}

                    {/* Form */}
                    <div className="form-group">
                        <label className="form-label" htmlFor={`${uid}-email`}>E-mail</label>
                        <input id={`${uid}-email`} className="form-input" value={user?.email || ''} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor={`${uid}-name`}>Nome</label>
                        <input id={`${uid}-name`} className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Seu nome" />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor={`${uid}-phone`}>Telefone (contato)</label>
                        <input id={`${uid}-phone`} className="form-input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(21) 99999-9999" />
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor={`${uid}-password`}>Nova senha (deixe vazio para manter)</label>
                        <input id={`${uid}-password`} className="form-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={`Mínimo ${minPassword} caracteres`} autoComplete="new-password"
                            aria-describedby={isStaff ? `${uid}-password-hint` : undefined} />
                        {isStaff && (
                            <div id={`${uid}-password-hint`} className="profile-hint">
                                Ao trocar a senha, as suas sessões em outros aparelhos são encerradas.
                            </div>
                        )}
                    </div>
                    {/* Ficha de cliente (CPF, endereço e redes): só para o CLIENTE. */}
                    {!isStaff && (
                        <>
                            <div className="form-group">
                                <label className="form-label" htmlFor={`${uid}-cpfcnpj`}>CPF / CNPJ</label>
                                <input id={`${uid}-cpfcnpj`} className="form-input" value={cpfCnpj} onChange={e => setCpfCnpj(maskCpfCnpj(e.target.value))} inputMode="numeric" placeholder="000.000.000-00" />
                            </div>
                            <div className="form-group">
                                <AddressFields values={addr} onChange={patch => setAddr(a => ({ ...a, ...patch }))} />
                            </div>
                            <div className="form-group">
                                <label className="form-label" htmlFor={`${uid}-instagram`}>Instagram</label>
                                <div className="profile-input-adorned">
                                    <span className="profile-input-adorned__prefix">@</span>
                                    <input id={`${uid}-instagram`} className="form-input" value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="usuario" />
                                </div>
                            </div>
                            <div className="form-group">
                                <label className="form-label" htmlFor={`${uid}-linkedin`}>LinkedIn (URL)</label>
                                <input id={`${uid}-linkedin`} className="form-input" value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/..." />
                            </div>
                        </>
                    )}
                    <div className="form-group">
                        <label className="form-label">Notificações</label>
                        <ToggleSwitch checked={essentialOnly} onChange={setEssentialOnly} label="Apenas notificações essenciais" disabled={saving} />
                        <div className="profile-hint">
                            {isStaff
                                ? 'Receba só os avisos importantes. Lembretes e dicas ficam silenciados.'
                                : 'Receba só avisos importantes (pagamentos e perda de crédito). Lembretes e dicas ficam silenciados.'}
                        </div>
                    </div>

                    <button className="btn btn-primary profile-save-btn" onClick={handleSave} disabled={saving}>
                        {saving ? <><Loader2 size={16} className="login-spinner" /> Salvando…</> : <><Save size={16} /> Salvar perfil</>}
                    </button>
                </div>
            )}
        </div>
    );
}
