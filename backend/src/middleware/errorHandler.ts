import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    console.error('Unhandled error:', err);

    if (err.name === 'ZodError') {
        res.status(400).json({
            error: 'Dados inválidos.',
            details: JSON.parse(err.message),
        });
        return;
    }

    // Origem fora da lista do CORS (index.ts): é recusa, não falha do servidor. O navegador nem expõe o
    // corpo (a resposta não tem os cabeçalhos do CORS), mas o status certo evita "Erro interno" nos logs/proxies.
    if (err.message === 'CORS not allowed') {
        res.status(403).json({ error: 'Origem não permitida.' });
        return;
    }

    // VULN-11 fix: Only expose stack in explicit development mode
    const isDev = config.nodeEnv === 'development';
    res.status(500).json({
        error: 'Erro interno do servidor.',
        ...(isDev && { stack: err.stack }),
    });
}
