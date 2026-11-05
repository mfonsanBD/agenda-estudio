import { describe, it, expect, vi } from 'vitest';
import { redis } from '../../src/lib/redis';

// Rodada 3, frente R3a — teardown da suíte (test/integration/setup.ts):
// a conexão pode cair ENTRE o pedido de QUIT e a resposta (o ioredis rejeita o QUIT pendente com
// "Connection is closed."), sem o status já ser 'end' quando o afterAll começa. Este arquivo simula esse
// QUIT rejeitado com a conexão ainda aberta: ele só passa se o afterAll do setup engolir a rejeição e
// fechar a conexão à força (redis.disconnect()).

describe('setup.ts — afterAll com o QUIT rejeitado', () => {
    it('o próximo QUIT rejeita com "Connection is closed." (o afterAll do setup precisa tolerar e desconectar)', async () => {
        expect(await redis.ping()).toBe('PONG');
        // Sem restore: o spy precisa valer até o afterAll do setup (que roda depois dos testes deste arquivo).
        vi.spyOn(redis, 'quit').mockRejectedValueOnce(new Error('Connection is closed.'));
        const disconnect = vi.spyOn(redis, 'disconnect');
        expect(redis.status).toBe('ready');
        expect(disconnect).not.toHaveBeenCalled();
    });
});
