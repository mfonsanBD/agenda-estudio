import { describe, it, expect } from 'vitest';
import { redis } from '../../src/lib/redis';

// Rodada 3, frente R3a — teardown da suíte (test/integration/setup.ts):
// o afterAll do setup fazia `await redis.quit()` sem proteção. Com a conexão JÁ encerrada (status 'end'),
// o ioredis rejeita com "Connection is closed." e o arquivo inteiro aparecia em "Failed Suites" com todos os
// testes verdes (visto no pix-discount-bidirectional na rodada 2). Este arquivo deixa a conexão encerrada de
// propósito: ele só passa se o afterAll do setup tolerar isso.

describe('setup.ts — afterAll com a conexão do Redis já encerrada', () => {
    it('encerra a conexão antes do teardown (o afterAll do setup não pode falhar por isso)', async () => {
        expect(await redis.ping()).toBe('PONG');
        const ended = new Promise<void>((resolve) => redis.once('end', () => resolve()));
        redis.disconnect();
        await ended;
        expect(redis.status).toBe('end');
        // Sem a proteção, é exatamente isto que o afterAll do setup faria:
        await expect(redis.quit()).rejects.toThrow('Connection is closed.');
    });
});
