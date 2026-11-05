import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../src/middleware/errorHandler.js';

function mockRes() {
    const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
    res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; }) as unknown as Response['status'];
    res.json = vi.fn((body: unknown) => { res.body = body; return res as Response; }) as unknown as Response['json'];
    return res;
}

describe('errorHandler', () => {
    it('origem fora do CORS responde 403 (não 500)', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();
        errorHandler(new Error('CORS not allowed'), {} as Request, res as Response, (() => {}) as NextFunction);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'Origem não permitida.' });
    });

    it('erro genérico continua 500', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = mockRes();
        errorHandler(new Error('boom'), {} as Request, res as Response, (() => {}) as NextFunction);
        expect(res.statusCode).toBe(500);
        expect((res.body as { error: string }).error).toBe('Erro interno do servidor.');
    });
});
