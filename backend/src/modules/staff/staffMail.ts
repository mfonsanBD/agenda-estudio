// ─── E-mails da tela Equipe e do acesso de clientes ─────
// Textos curtos e sem segredo: nenhum e-mail daqui leva senha ou código. O acesso da equipe reaproveita o
// login por código no e-mail (POST /api/auth/login/send-code), então "Enviar acesso" só diz onde entrar.

import { config } from '../../config/index.js';
import { getConfigString } from '../../lib/businessConfig.js';
import { sendEmail } from '../../lib/email.js';

const DEFAULT_STUDIO_NAME = 'Estúdio Búzios Digital';

/** Escapa texto para o HTML do e-mail (nome digitado pelo admin, nome do estúdio). */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "joao@x.com" → "j***@x.com" (auditoria e avisos: nunca o e-mail inteiro de outra pessoa). */
export function maskEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email[0]}***${email.slice(at)}`;
}

async function studioName(): Promise<string> {
    try {
        return (await getConfigString('studio_name')) || DEFAULT_STUDIO_NAME;
    } catch {
        return DEFAULT_STUDIO_NAME;
    }
}

function loginUrl(): string {
    return `${config.frontendUrl.replace(/\/+$/, '')}/login`;
}

/** Casca HTML simples (tabela + estilos inline, como o e-mail do código de login). */
function wrapHtml(studio: string, paragraphs: string[]): string {
    const body = paragraphs
        .map(p => `<p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:#c9d6de;">${p}</p>`)
        .join('');
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${studio}</title></head>
<body style="margin:0; padding:0; background-color:#0b1620; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b1620; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#10212e; border:1px solid #1d3340; border-radius:16px; overflow:hidden;">
        <tr><td style="background:linear-gradient(135deg,#0e6f86,#11819b); padding:24px 32px; text-align:center;">
          <div style="font-size:20px; font-weight:800; color:#ffffff;">${studio}</div>
        </td></tr>
        <tr><td style="padding:28px 32px 12px;">${body}</td></tr>
        <tr><td style="padding:16px 32px; border-top:1px solid #1d3340; text-align:center;">
          <p style="margin:0; font-size:12px; color:#5f7585;">© ${studio} · Este é um e-mail automático.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * "Enviar acesso" (POST /api/staff/:id/send-access e criação com sendAccessEmail): avisa a pessoa de que
 * entrou na equipe e onde entrar. Lança se o provedor de e-mail falhar (quem chama decide a resposta).
 */
export async function sendStaffAccessEmail(member: { name: string; email: string }): Promise<void> {
    const studio = await studioName();
    const url = loginUrl();
    const s = escapeHtml(studio);
    const link = `<a href="${escapeHtml(url)}" style="color:#33c4e0;">${escapeHtml(url)}</a>`;
    await sendEmail({
        to: member.email,
        subject: `Seu acesso à equipe do ${studio}`,
        html: wrapHtml(s, [
            `<strong style="color:#e8eef2;">Olá, ${escapeHtml(member.name)}.</strong>`,
            `Você foi adicionado à equipe do ${s}. Entre em ${link} com este e-mail (<strong style="color:#e8eef2;">${escapeHtml(member.email)}</strong>); você receberá um código.`,
            'Se você não esperava este e-mail, ignore-o.',
        ]),
    });
}

/**
 * Aviso ao e-mail ANTIGO quando o e-mail de login é trocado pelo estúdio (cliente: PATCH /api/users/:id;
 * equipe: PATCH /api/staff/:id). Melhor esforço: nunca lança e não segura a resposta (dispara e segue).
 */
export function notifyLoginEmailChanged(oldEmail: string, newEmail: string, name: string): void {
    void (async () => {
        const studio = await studioName();
        const s = escapeHtml(studio);
        await sendEmail({
            to: oldEmail,
            subject: `O e-mail de acesso da sua conta no ${studio} foi alterado`,
            html: wrapHtml(s, [
                `<strong style="color:#e8eef2;">Olá, ${escapeHtml(name)}.</strong>`,
                `O e-mail de acesso da sua conta no ${s} foi alterado pelo estúdio para <strong style="color:#e8eef2;">${escapeHtml(maskEmail(newEmail) ?? '')}</strong>. As sessões abertas foram encerradas.`,
                'Se você não reconhece essa mudança, fale com o estúdio.',
            ]),
        });
    })().catch(err => {
        console.error('[ACCESS] Falha ao avisar o e-mail antigo sobre a troca do e-mail de acesso:', err instanceof Error ? err.message : err);
    });
}
