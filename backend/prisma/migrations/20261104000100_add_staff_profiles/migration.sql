-- Dados exclusivos da EQUIPE (ADMIN/COLABORADOR), 1:1 com users. Cliente nunca tem linha aqui.
--
--  • title       → cargo exibido na tela Equipe (ex.: "Recepção"). NULL = sem cargo.
--  • permissions → chaves do catálogo (backend/src/config/staffPermissions.ts), normalizadas ao
--                  salvar (dependências aplicadas, exclusivas do ADMIN removidas). Só valem para
--                  COLABORADOR: o ADMIN tem acesso total e a lista é ignorada.
--  • FK user_id → users.id ON DELETE CASCADE (a linha some junto com o usuário).
--
-- Aditiva, sem backfill: o código anterior ignora a tabela (deploy em duas etapas — migrations
-- primeiro, código depois). Idempotente para re-execução segura: CREATE TABLE IF NOT EXISTS e a FK
-- dentro de um bloco que confere pg_constraint.
CREATE TABLE IF NOT EXISTS "staff_profiles" (
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("user_id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_profiles_user_id_fkey') THEN
        ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;
