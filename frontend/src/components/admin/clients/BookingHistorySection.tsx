import React, { useState, useId } from 'react';
import { bookingsApi, Booking } from '../../../api/client';
import StatusBadge from '../../ui/StatusBadge';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { formatBRL } from '../../../utils/format';
import { ChevronRight, NotebookPen, Lock, Eye, BarChart3, Save, CheckCircle2, Music } from 'lucide-react';
import { useBookingPermissions } from '../bookings/bookingPermissions';

export interface BookingNotesPatch {
    adminNotes: string;
    clientNotes: string;
    durationMinutes: number | null;
    peakViewers: number | null;
    chatMessages: number | null;
    audienceOrigin: string | null;
}

interface BookingHistorySectionProps {
    bookings: Booking[];
    /** Aplica o patch salvo no estado do cliente (merge em user.bookings na página). */
    onBookingUpdated: (bookingId: string, patch: BookingNotesPatch) => void;
}

/** Histórico de agendamentos com notas/métricas por sessão (expansão inline). */
export default function BookingHistorySection({ bookings, onBookingUpdated }: BookingHistorySectionProps) {
    const uid = useId();
    // Notas e métricas da sessão (PATCH /bookings/:id): hoje.gravacao OU agendamentos.editar. Sem elas,
    // a sessão abre só para leitura.
    const { canEditNotes } = useBookingPermissions();
    const [expandedBookingId, setExpandedBookingId] = useState<string | null>(null);
    const [bookingAdminNotes, setBookingAdminNotes] = useState('');
    const [bookingClientNotes, setBookingClientNotes] = useState('');
    const [bookingDuration, setBookingDuration] = useState<number | ''>('');
    const [bookingPeak, setBookingPeak] = useState<number | ''>('');
    const [bookingChat, setBookingChat] = useState<number | ''>('');
    const [bookingOrigin, setBookingOrigin] = useState('');
    const [bookingNotesSaving, setBookingNotesSaving] = useState(false);
    const [bookingNotesSaved, setBookingNotesSaved] = useState(false);

    const contractBookings = bookings.filter(b => b.contractId);
    const avulsoBookings = bookings.filter(b => !b.contractId);

    const toggleBookingNotes = (b: Booking) => {
        if (expandedBookingId === b.id) {
            setExpandedBookingId(null);
        } else {
            setExpandedBookingId(b.id);
            setBookingAdminNotes(b.adminNotes || '');
            setBookingClientNotes(b.clientNotes || '');
            setBookingDuration(b.durationMinutes || '');
            setBookingPeak(b.peakViewers || '');
            setBookingChat(b.chatMessages || '');
            setBookingOrigin(b.audienceOrigin || '');
            setBookingNotesSaved(false);
        }
    };

    const saveBookingNotes = async (bookingId: string) => {
        setBookingNotesSaving(true);
        try {
            const updatePayload: BookingNotesPatch = {
                adminNotes: bookingAdminNotes,
                clientNotes: bookingClientNotes,
                durationMinutes: bookingDuration === '' ? null : Number(bookingDuration),
                peakViewers: bookingPeak === '' ? null : Number(bookingPeak),
                chatMessages: bookingChat === '' ? null : Number(bookingChat),
                audienceOrigin: bookingOrigin || null,
            };
            await bookingsApi.update(bookingId, updatePayload);
            onBookingUpdated(bookingId, updatePayload);
            setBookingNotesSaved(true);
            setTimeout(() => setBookingNotesSaved(false), 2000);
        } catch (err) { console.error(err); }
        finally { setBookingNotesSaving(false); }
    };

    const renderBookingRow = (b: Booking) => (
        <React.Fragment key={b.id}>
            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBookingNotes(b)}
                tabIndex={0} role="button" aria-expanded={expandedBookingId === b.id}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBookingNotes(b); } }}>
                <td className="admin-card-title">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <ChevronRight size={13} aria-hidden="true" style={{ transform: expandedBookingId === b.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </div>
                </td>
                <td data-label="Horário" style={{ fontWeight: 600 }}>{b.startTime}–{b.endTime}</td>
                <td data-label="Faixa"><StatusBadge meta={getMeta(TIER_META, b.tierApplied)} /></td>
                <td data-label="Valor">{formatBRL(b.price)}</td>
                <td data-label="Status">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <StatusBadge meta={getMeta(BOOKING_STATUS_META, b.status)} />
                        {(b.adminNotes || b.clientNotes) && <NotebookPen size={13} style={{ color: 'var(--text-muted)' }} aria-label="Possui observações" />}
                    </div>
                </td>
            </tr>
            {expandedBookingId === b.id && (
                <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                        <div style={{
                            padding: '16px', background: 'var(--bg-secondary)',
                            borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)',
                        }}>
                            <div className="admin-grid-2" style={{ gap: '12px' }}>
                                <div>
                                    <label htmlFor={`${uid}-adminNotes`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-text)', marginBottom: '6px' }}>
                                        <Lock size={13} aria-hidden="true" /> Observação do Admin (somente admin)
                                    </label>
                                    <textarea
                                        id={`${uid}-adminNotes`}
                                        className="form-input"
                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                        placeholder="Anotações internas sobre esta sessão..."
                                        readOnly={!canEditNotes}
                                        value={bookingAdminNotes}
                                        onChange={e => { setBookingAdminNotes(e.target.value); setBookingNotesSaved(false); }}
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${uid}-clientNotes`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px' }}>
                                        <Eye size={13} aria-hidden="true" /> Observação para o Cliente (visível ao cliente)
                                    </label>
                                    <textarea
                                        id={`${uid}-clientNotes`}
                                        className="form-input"
                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                        placeholder="Feedback ou observações para o cliente ver..."
                                        readOnly={!canEditNotes}
                                        value={bookingClientNotes}
                                        onChange={e => { setBookingClientNotes(e.target.value); setBookingNotesSaved(false); }}
                                    />
                                </div>
                            </div>

                            {b.status === 'COMPLETED' && (
                                <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                                    <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <BarChart3 size={15} aria-hidden="true" /> Métricas Pós-Gravação
                                    </h4>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" htmlFor={`${uid}-duration`} style={{ fontSize: '0.75rem' }}>Duração (minutos)</label>
                                            <input id={`${uid}-duration`} type="number" className="form-input" placeholder="Ex: 120" readOnly={!canEditNotes} value={bookingDuration} onChange={e => { setBookingDuration(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" htmlFor={`${uid}-peak`} style={{ fontSize: '0.75rem' }}>Pico Simultâneo</label>
                                            <input id={`${uid}-peak`} type="number" className="form-input" placeholder="Ex: 1530" readOnly={!canEditNotes} value={bookingPeak} onChange={e => { setBookingPeak(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" htmlFor={`${uid}-chat`} style={{ fontSize: '0.75rem' }}>Mensagens no Chat</label>
                                            <input id={`${uid}-chat`} type="number" className="form-input" placeholder="Ex: 2400" readOnly={!canEditNotes} value={bookingChat} onChange={e => { setBookingChat(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" htmlFor={`${uid}-origin`} style={{ fontSize: '0.75rem' }}>Origem de Audiência</label>
                                            <input id={`${uid}-origin`} type="text" className="form-input" placeholder="Ex: Tráfego Pago SP" readOnly={!canEditNotes} value={bookingOrigin} onChange={e => { setBookingOrigin(e.target.value); setBookingNotesSaved(false); }} />
                                        </div>
                                    </div>
                                </div>
                            )}

                            {canEditNotes && (
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px', alignItems: 'center' }}>
                                    {bookingNotesSaved && <span style={{ fontSize: '0.75rem', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><CheckCircle2 size={13} aria-hidden="true" /> Salvo</span>}
                                    <button className="btn-admin-go" style={{ minHeight: 36, padding: '8px 16px', fontSize: '0.8125rem' }} onClick={() => saveBookingNotes(b.id)} disabled={bookingNotesSaving}>
                                        {bookingNotesSaving ? 'Salvando…' : <><Save size={14} aria-hidden="true" /> Salvar Observações</>}
                                    </button>
                                </div>
                            )}
                        </div>
                    </td>
                </tr>
            )}
        </React.Fragment>
    );

    return (
        <div>
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Music size={17} aria-hidden="true" /> Histórico de Agendamentos ({bookings.length} total)
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                {canEditNotes
                    ? 'Clique em uma sessão para adicionar observações do admin ou para o cliente.'
                    : 'Clique em uma sessão para ver as observações e métricas.'}
            </p>

            {contractBookings.length > 0 && (
                <div className="card" style={{ marginBottom: '16px' }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.875rem', color: 'var(--accent-primary)' }}>
                        Vinculados a Contrato ({contractBookings.length})
                    </div>
                    <div className="table-container">
                        <div className="admin-table-wrap">
                            <table className="admin-table--cards">
                                <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                <tbody>{contractBookings.map(renderBookingRow)}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {avulsoBookings.length > 0 && (
                <div className="card">
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.875rem', color: 'var(--tier-audiencia)' }}>
                        Avulsos ({avulsoBookings.length})
                    </div>
                    <div className="table-container">
                        <div className="admin-table-wrap">
                            <table className="admin-table--cards">
                                <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                <tbody>{avulsoBookings.map(renderBookingRow)}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {bookings.length === 0 && (
                <div className="card"><div className="admin-empty"><Music size={44} className="admin-empty__icon" aria-hidden="true" /><div className="admin-empty__title">Nenhum agendamento</div></div></div>
            )}
        </div>
    );
}
