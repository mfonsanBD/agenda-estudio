import { describe, it, expect, vi } from 'vitest';
import { requiredForBookingStatusChange } from '../src/lib/permissionRules';
import { allPermissionKeys, buildStaffCatalog, levelOf, modulesWithAccess, normalizePermissions } from '../src/config/staffPermissions';

// O espelho do front importa React e o hook usePermission; aqui só as funções puras interessam.
vi.mock('react', () => ({ useMemo: (f: () => unknown) => f() }));
vi.mock('../../frontend/src/hooks/usePermission', () => ({ usePermission: () => { throw new Error('stub'); } }));

import { bookingStatusRequirements } from '../../frontend/src/components/admin/bookings/bookingPermissions';
import * as team from '../../frontend/src/components/admin/team/teamPermissions';

// FRENTE INTEGRAÇÃO — as regras que o front REPETE para decidir o que mostrar precisam ser as do servidor
// (DECISOES D3: "o front usa a mesma tabela para filtrar opções"; D2: dependências "normalizadas no servidor
// ao salvar e travadas na UI"). Transforma em teste os scripts de paridade das frentes F2a e F3: quem mudar a
// regra de um lado sem o outro quebra aqui.

const STATUSES = ['RESERVED', 'HELD', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED', 'DESCONHECIDO'];
const norm = (r: readonly (readonly string[])[] | 'ADMIN') =>
    (r === 'ADMIN' ? [['ADMIN']] : r).map(g => [...g].sort().join('|')).sort().join(' & ');

describe('agendamento: espelho do front (bookingPermissions.ts) × requiredForBookingStatusChange', () => {
    it('todas as transições (de × para × gravação iniciada) exigem o mesmo', () => {
        const diffs: string[] = [];
        for (const from of STATUSES) for (const to of STATUSES) for (const recordingStarted of [false, true]) {
            const front = norm(bookingStatusRequirements(from, to, { recordingStarted }));
            const back = norm(requiredForBookingStatusChange(from, to, { recordingStarted }));
            if (front !== back) diffs.push(`${from} → ${to} (gravação ${recordingStarted}): front ${front} × servidor ${back}`);
        }
        expect(diffs).toEqual([]);
    });
});

describe('Equipe: lógica da etapa Permissões (teamPermissions.ts) × catálogo do servidor', () => {
    const catalog = buildStaffCatalog() as unknown as Parameters<typeof team.indexCatalog>[0];
    const idx = team.indexCatalog(catalog);
    const keys = allPermissionKeys();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const sets: string[][] = [[], keys, ...catalog.presets.map(p => [...p.permissions])];
    for (let i = 0; i < 1500; i++) sets.push(keys.filter(() => rnd() < 0.3));

    it('fecho das dependências = normalizePermissions; nível por módulo = levelOf; "N módulos" igual', () => {
        const diffs: string[] = [];
        for (const set of sets) {
            const closedFront = team.closePermissions(set, idx);
            const closedBack = normalizePermissions(set).permissions;
            if (JSON.stringify(closedFront) !== JSON.stringify(closedBack)) diffs.push(`fecho ${set.join(',')}`);
            for (const m of catalog.modules) {
                const a = team.moduleLevel(m, new Set(closedFront));
                const b = levelOf(m.key, closedFront);
                if (a !== b) diffs.push(`nível ${m.key} ${closedFront.join(',')}: ${a} × ${b}`);
            }
            const ma = team.modulesWithAccess(catalog, closedFront).map(m => m.key).join();
            if (ma !== modulesWithAccess(closedFront).join()) diffs.push(`módulos ${closedFront.join(',')}`);
            if (diffs.length > 10) break;
        }
        expect(diffs).toEqual([]);
    });

    it('escolher um nível na tela e ler de volta dá o mesmo nível do servidor', () => {
        for (const m of catalog.modules) {
            for (const lvl of team.availableLevels(m)) {
                const out = team.applyLevel([], m, lvl, idx);
                expect(levelOf(m.key, out), `${m.key}/${lvl}`).toBe(lvl);
            }
        }
    });
});
