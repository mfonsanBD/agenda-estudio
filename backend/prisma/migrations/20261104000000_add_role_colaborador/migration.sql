-- Papel COLABORADOR: membro da equipe que acessa a área administrativa limitado às permissões
-- marcadas pelo administrador (tela Equipe). ADMIN continua com acesso total; CLIENTE não muda.
--
-- Sozinha no arquivo: o Postgres não permite USAR um valor de enum na mesma transação em que ele
-- foi adicionado — qualquer migration de dados que use 'COLABORADOR' vai num arquivo próprio.
-- O valor entra no FIM do enum (ADMIN, CLIENTE, COLABORADOR), a mesma ordem do schema.prisma.
-- Aditiva, sem backfill (todo ADMIN continua ADMIN). Idempotente: ADD VALUE IF NOT EXISTS é seguro
-- de re-executar a cada deploy.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'COLABORADOR';
