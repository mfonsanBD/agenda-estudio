import "dotenv/config";
import {
  PrismaClient,
  Role,
  Tier,
  ContractType,
  ContractStatus,
  BookingStatus,
} from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { STAFF_PRESETS } from "../src/config/staffPermissions";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Wiping database and seeding comprehensive edge cases...");

  // Clean existing data
  await prisma.savedPaymentMethod.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.blockedSlot.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.user.deleteMany();

  const clientPassword = await bcrypt.hash("cliente123", 12);
  const adminPassword = await bcrypt.hash("admin123", 12);

  // ─── 1. Admin User ──────────────────────────────────────────
  const admin = await prisma.user.create({
    data: {
      email: "admin@studio.com",
      passwordHash: adminPassword,
      name: "Administrador",
      phone: "(21) 99999-0000",
      role: Role.ADMIN,
    },
  });
  console.log(`  ✅ Admin: ${admin.email} / admin123`);

  // ─── 1b. Colaborador de exemplo (equipe com o perfil Recepção) ─
  // Mesma convenção de senha do admin do seed. As permissões são as do perfil modelo (só as chaves
  // vão para o banco; o staff_profiles some junto com o usuário — FK CASCADE).
  const recepcao = STAFF_PRESETS.find((p) => p.key === "recepcao");
  const colabPassword = await bcrypt.hash("colab123", 12);
  const colab = await prisma.user.create({
    data: {
      email: "colab@studio.com",
      passwordHash: colabPassword,
      name: "Colaborador Recepção",
      phone: "(21) 99999-0001",
      role: Role.COLABORADOR,
      staffProfile: {
        create: {
          title: "Recepção",
          permissions: [...(recepcao?.permissions ?? [])],
        },
      },
    },
  });
  console.log(`  ✅ Colaborador: ${colab.email} / colab123 (perfil Recepção)`);

  const now = new Date();
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setMonth(now.getMonth() - 1);
  const twoMonthsAgo = new Date(now);
  twoMonthsAgo.setMonth(now.getMonth() - 2);
  const threeMonthsLater = new Date(now);
  threeMonthsLater.setMonth(now.getMonth() + 3);
  const sixMonthsLater = new Date(now);
  sixMonthsLater.setMonth(now.getMonth() + 6);

  // ─── 2. New Client (No Contracts) ───────────────────────────
  const newClient = await prisma.user.create({
    data: {
      email: "cliente@teste.com",
      passwordHash: clientPassword,
      name: "Cliente Principal",
      phone: "(21) 91111-1111",
      role: Role.CLIENTE,
    },
  });
  console.log(`  ✅ Cliente Novo: ${newClient.email}`);

  // ─── 3. Business Config (upsert new groups) ────────────────
  const configEntries = [
    // schedule
    {
      key: "time_slots",
      value: "10:00,13:00,15:30,18:00,20:30",
      type: "string",
      label: "Horários dos Blocos",
      group: "schedule",
    },
    {
      key: "slot_duration_hours",
      value: "2",
      type: "number",
      label: "Duração do Bloco (horas)",
      group: "schedule",
    },
    {
      key: "comercial_slots",
      value: "10:00,13:00,15:30",
      type: "string",
      label: "Horários Faixa Comercial",
      group: "schedule",
    },
    {
      key: "audiencia_slots",
      value: "18:00,20:30",
      type: "string",
      label: "Horários Faixa Audiência",
      group: "schedule",
    },
    {
      key: "operating_days",
      value: "1,2,3,4,5,6",
      type: "string",
      label: "Dias de Funcionamento (1=Seg…6=Sáb)",
      group: "schedule",
    },
    {
      key: "close_time",
      value: "23:00",
      type: "string",
      label: "Horário de Fechamento",
      group: "schedule",
    },
    // gateway
    {
      key: "gateway_stripe_fee_pct",
      value: "3.99",
      type: "percent",
      label: "Taxa Stripe (%)",
      group: "gateway",
    },
    {
      key: "gateway_stripe_fee_cents",
      value: "39",
      type: "number",
      label: "Taxa Fixa Stripe por Transação (centavos)",
      group: "gateway",
    },
    {
      key: "gateway_cora_fee_cents",
      value: "200",
      type: "number",
      label: "Taxa Cora por Boleto (centavos)",
      group: "gateway",
    },
    {
      key: "card_installment_surcharges",
      value: JSON.stringify({
        "1": 0,
        "2": 6,
        "3": 8,
        "4": 9,
        "5": 10,
        "6": 12,
        "7": 13,
        "8": 14,
        "9": 16,
        "10": 17,
        "11": 19,
        "12": 20,
      }),
      type: "json",
      label: "Taxas de Parcelamento Cartão (%)",
      group: "payments",
    },
    // booking
    {
      key: "first_booking_min_days",
      value: "1",
      type: "number",
      label: "Dias mín. p/ 1º agendamento",
      group: "policies",
    },
    {
      key: "first_booking_max_days",
      value: "14",
      type: "number",
      label: "Dias máx. p/ 1º agendamento",
      group: "policies",
    },
    {
      key: "sessions_per_month",
      value: "4",
      type: "number",
      label: "Sessões por mês",
      group: "plans",
    },
    {
      key: "discount_3months",
      value: "30",
      type: "percent",
      label: "Desconto Fidelidade 3 meses (%)",
      group: "plans",
    },
    {
      key: "discount_6months",
      value: "40",
      type: "percent",
      label: "Desconto Fidelidade 6 meses (%)",
      group: "plans",
    },
    {
      key: "episodes_3months",
      value: "12",
      type: "number",
      label: "Episódios p/ contrato 3 meses",
      group: "plans",
    },
    {
      key: "episodes_6months",
      value: "24",
      type: "number",
      label: "Episódios p/ contrato 6 meses",
      group: "plans",
    },
    // studio
    {
      key: "studio_name",
      value: "Estúdio Búzios Digital",
      type: "string",
      label: "Nome do Estúdio",
      group: "studio",
    },
    {
      key: "studio_logo_url",
      value:
        "https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg",
      type: "string",
      label: "URL do Logo",
      group: "studio",
    },
    {
      key: "studio_email",
      value: "contato@buzios.digital",
      type: "string",
      label: "E-mail de Contato",
      group: "studio",
    },
    {
      key: "studio_hero_image",
      value: "/images/hero-estudio.webp",
      type: "string",
      label: "Imagem Principal",
      group: "studio",
    },
    {
      key: "studio_location",
      value: "Búzios, RJ",
      type: "string",
      label: "Localização",
      group: "studio",
    },
  ];

  for (const entry of configEntries) {
    await prisma.businessConfig.upsert({
      where: { key: entry.key },
      create: entry,
      update: {}, // don't overwrite existing values
    });
  }
  console.log(
    `  ✅ Business config: ${configEntries.length} chaves (schedule/gateway/studio)`,
  );

  // ─── 4. Pricing Config (tier prices) ───────────────────────
  const pricingEntries = [
    {
      tier: "COMERCIAL" as const,
      price: 30000,
      label: "Comercial",
      description: "Faixa horário comercial (10h–17h)",
    },
    {
      tier: "AUDIENCIA" as const,
      price: 40000,
      label: "Audiência",
      description: "Faixa prime-time (18h–22h)",
    },
    {
      tier: "SABADO" as const,
      price: 50000,
      label: "Sábado",
      description: "Sábado (horário premium)",
    },
  ];

  for (const entry of pricingEntries) {
    await prisma.pricingConfig.upsert({
      where: { tier: entry.tier },
      create: entry,
      update: {}, // don't overwrite existing values
    });
  }
  console.log(`  ✅ Pricing config: ${pricingEntries.length} tiers`);

  // ─── 5. AddOn Configs (extra services) ──────────────────────
  // Two families discriminated by `monthly`: per-episode add-ons (false, accompany every
  // recording) and monthly subscription services (true, standalone SERVICO contracts).
  // Monthly services carry richer metadata (benefits/durations/plans/cadence) used by the
  // self-serve wizard; the admin can edit all of this in Configurações → Serviços.
  const addonEntries = [
    {
      key: "CORTES_IA",
      name: "Cortes com IA",
      price: 30000,
      description:
        "Cortes automáticos do episódio usando inteligência artificial para shorts e reels.",
      monthly: false,
      icon: "Scissors",
      benefits: null as string | null,
      durationsOffered: "3,6",
      plansAllowed: "FULL",
      billingCadence: "BILLING_CYCLE_28",
    },
    {
      key: "CORTES_HUMANO",
      name: "Cortes por Editor",
      price: 800000,
      description:
        "Cortes manuais feitos por editor profissional com curadoria e storytelling.",
      monthly: false,
      icon: "Film",
      benefits: null as string | null,
      durationsOffered: "3,6",
      plansAllowed: "FULL",
      billingCadence: "BILLING_CYCLE_28",
    },
    {
      key: "GESTAO_SOCIAL",
      name: "Gestão de Redes Sociais",
      price: 200000,
      description:
        "Seu podcast presente todos os dias: nossa equipe cuida da publicação, dos cortes, do SEO e do crescimento das suas redes — você foca em gravar e nós cuidamos do alcance.",
      monthly: true,
      icon: "Share2",
      benefits: JSON.stringify([
        "Criação de artes para publicação",
        "Contato e agendamento com os convidados",
        "Making-of e bastidores das gravações",
        "Cortes e edição com foco em alcance",
        "Otimização de SEO, títulos e descrições",
        "Relatório mensal de métricas e crescimento",
      ]),
      durationsOffered: "3,6",
      plansAllowed: "MONTHLY,FULL",
      billingCadence: "CALENDAR_MONTH",
    },
    {
      key: "GESTAO_TRAFEGO",
      name: "Gestão de Tráfego e Anúncios",
      price: 150000,
      description:
        "Gestão completa de campanhas de anúncios (Meta e Google) para o seu podcast: criativos, segmentação e otimização contínua para escalar alcance e audiência.",
      monthly: true,
      icon: "TrendingUp",
      benefits: JSON.stringify([
        "Criação de criativos para anúncios",
        "Segmentação e públicos estratégicos",
        "Gestão e otimização contínua das campanhas",
        "Relatório mensal de resultados (ROAS)",
      ]),
      durationsOffered: "3,6",
      plansAllowed: "MONTHLY,FULL",
      billingCadence: "CALENDAR_MONTH",
    },
    {
      key: "YOUTUBE_SEO",
      name: "YouTube SEO",
      price: 20000,
      description:
        "Otimização de título, descrição, tags e thumbnail para melhor ranqueamento no YouTube.",
      monthly: false,
      icon: "Search",
      benefits: null as string | null,
      durationsOffered: "3,6",
      plansAllowed: "FULL",
      billingCadence: "BILLING_CYCLE_28",
    },
    {
      key: "PAUTAS",
      name: "Roteiro & Pautas",
      price: 90000,
      description:
        "Criação de roteiro e pauta para cada episódio, com pesquisa de temas e perguntas-chave.",
      monthly: false,
      icon: "FileText",
      benefits: null as string | null,
      durationsOffered: "3,6",
      plansAllowed: "FULL",
      billingCadence: "BILLING_CYCLE_28",
    },
  ];

  for (const entry of addonEntries) {
    await prisma.addOnConfig.upsert({
      where: { key: entry.key },
      create: entry,
      // Refresh only the service-contract behavior metadata so existing rows pick up the
      // correct family settings, WITHOUT clobbering admin-editable presentation
      // (icon/benefits) or price/name/description/active.
      update: {
        durationsOffered: entry.durationsOffered,
        plansAllowed: entry.plansAllowed,
        billingCadence: entry.billingCadence,
      },
    });
  }
  console.log(`  ✅ AddOn config: ${addonEntries.length} serviços (por episódio + mensais)`);

  // ── PaymentMethodConfig ──────────────────────────────────
  const paymentMethods = [
    { key: 'PIX', label: 'PIX', shortLabel: 'PIX', emoji: '⚡', description: 'Pagamento instantâneo', color: '#22c55e', active: true, sortOrder: 0, accessMode: 'FULL' },
    { key: 'CARTAO', label: 'Cartão de Crédito', shortLabel: 'Cartão', emoji: '💳', description: 'Crédito ou débito', color: '#8b5cf6', active: true, sortOrder: 1, accessMode: 'FULL' },
    // Boleto desativado: PIX passou para o Sicoob (que só faz PIX) e o boleto era exclusivo da Cora.
    { key: 'BOLETO', label: 'Boleto Bancário', shortLabel: 'Boleto', emoji: '📄', description: 'Compensação em até 3 dias úteis', color: '#f59e0b', active: false, sortOrder: 2, accessMode: 'PROGRESSIVE' },
  ];
  for (const pm of paymentMethods) {
    await prisma.paymentMethodConfig.upsert({ where: { key: pm.key }, create: pm, update: {} });
  }
  console.log(`  ✅ Payment methods: ${paymentMethods.length} métodos`);

  // ── IntegrationConfig (dev defaults) ─────────────────────
  const integrations = [
    { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' },
    // PIX agora é atendido pelo Sicoob (sandbox usa credenciais públicas de teste, sem certificado).
    { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' },
    // Cora mantida como opção extra de PIX, porém DESLIGADA por padrão (admin pode reativar).
    { provider: 'CORA', enabled: false, environment: 'sandbox', config: '{}' },
  ];
  for (const intg of integrations) {
    await prisma.integrationConfig.upsert({ where: { provider: intg.provider }, create: intg, update: {} });
  }
  console.log(`  ✅ Integration configs: ${integrations.length} providers`);

  console.log("\n✨ Database Reset completed successfully!");
  console.log("\nCredenciais limitadas prontas para teste:");
  console.log("  🛡️ Admin:     admin@studio.com (admin123)");
  console.log("  🧑‍💼 Colab:     colab@studio.com (colab123) — perfil Recepção");
  console.log("  👤 Cliente:   cliente@teste.com (cliente123)");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
