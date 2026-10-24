//! Cofre DeoZERA: saldos dos jogadores (em USDC) e apostas das partidas, na blockchain Solana.
//! Escrito com Pinocchio (programa pequeno = deposito de aluguel pequeno na rede). Mantem a MESMA interface da
//! versao Anchor (identificadores das instrucoes, ordem das contas, formato dos dados), descrita em idl/cofre.json.
//!
//! Regras de seguranca (o que o codigo garante):
//! 1. O saldo de cada jogador fica numa conta de tokens do programa (PDA) SEM chave privada. Ninguem "tem" o cofre.
//! 2. Saque: so a assinatura do dono, so para uma conta de tokens do dono. Funciona mesmo com o programa pausado.
//! 3. Deposito: sempre assinado pelo proprio jogador. Aposta: pelo jogador ou por uma "chave de aposta" que ele
//!    autorizou com a propria carteira (fica no navegador dele; so trava aposta em partida, nunca saca nem
//!    transfere, e o jogador revoga quando quiser). O servidor sozinho nao trava aposta de ninguem.
//!    "Saldo trancado" (so o dono tranca e destranca, pela wallet): nenhuma chave de aposta aposta.
//! 4. O arbitro (servidor) so informa o resultado e quem abandonou: o valor travado se move entre os jogadores
//!    daquela partida; as unicas saidas sao a taxa da partida (6) e a pool de abandono (4b). Aposta tem teto.
//! 4b. Pool de abandono: quem abandona a partida nao recebe nada dela. O que ele receberia (a propria aposta de
//!     volta e, se o time venceu, o premio) vai para a carteira de taxas. Os outros jogadores recebem exatamente o
//!     mesmo que receberiam sem o abandono. Nunca mais que a parte dele; nunca todos os jogadores da partida.
//! 5. Se o arbitro nao liquidar no prazo, qualquer um pode cancelar e cada jogador recebe a aposta de volta.
//! 6. A taxa e cobrada so nas partidas com vencedor: uma porcentagem do pote (as apostas dos dois times), tirada do
//!    que o time vencedor recebe, com teto fixo no codigo, e vai para a carteira de taxas configurada. Empate,
//!    cancelamento, deposito e saque nao tem taxa.
//! 6b. Tetos opcionais de deposito (para testes e beta; 0 = sem teto): saldo por cofre e total guardado no programa.
//!     So barram DEPOSITO: saque, aposta e pagamento de partida nunca sao barrados por teto.
//! 7. So a autoridade de atualizacao do programa inicializa; troca de admin em duas etapas.
//! 8. A moeda (USDC) e gravada na inicializacao e NUNCA muda; so o programa de token classico e aceito.
//!
//! Sem o Anchor, cada conta e conferida a mao: dono (programa), identificador (8 bytes), tamanho, endereco (PDA)
//! e quem assina. Toda conta recebida passa por uma dessas conferencias antes de ser usada.
#![no_std]

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    no_allocator, nostd_panic_handler, program_entrypoint,
    program_error::ProgramError,
    pubkey::{create_program_address, find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer as TransferirSol};
use pinocchio_token::instructions::{CloseAccount, InitializeAccount3, Transfer};

pinocchio_pubkey::declare_id!("E2zft5kPUBFgwbJYLSLMdx92TDT4Ajyddtczg3ByJ3XX");

program_entrypoint!(processar);
no_allocator!();

// Contato de seguranca embutido no programa (padrao security.txt da Solana, o mesmo formato da macro
// `solana-security-txt`; exploradores como o Solscan mostram). Escrito a mao para nao trazer dependencia nova.
#[cfg_attr(target_os = "solana", link_section = ".security.txt")]
#[allow(dead_code, non_upper_case_globals)]
#[no_mangle]
pub static security_txt: &str = concat!(
    "=======BEGIN SECURITY.TXT V1=======\0",
    "name\0", "DeoZERA - Cofre\0",
    "project_url\0", "https://deozera.com.br\0",
    "contacts\0", "email:contato@deozera.com.br\0",
    "policy\0", "https://deozera.com.br/seguranca\0",
    "preferred_languages\0", "pt,en\0",
    "source_code\0", "https://github.com/deoplacido28/deozera-cofre\0",
    "=======END SECURITY.TXT V1=======\0",
);
nostd_panic_handler!();

const TOKEN: Pubkey = pinocchio_token::ID;
const SISTEMA: Pubkey = pinocchio_system::ID;
const CARREGADOR: Pubkey = pinocchio_pubkey::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// Teto fixo da taxa das partidas: 10% do pote (1000 pontos-base). Nem o admin passa disso.
const TAXA_MAXIMA_BPS: u16 = 1_000;
/// Jogadores por time (1x1 ate 4x4).
const MAX_POR_TIME: usize = 4;
/// Prazo para todos travarem a aposta depois que a partida e criada.
const PRAZO_ENTRAR_S: i64 = 10 * 60;
/// Se a partida travada nao for liquidada neste prazo, qualquer um pode cancelar (todos recebem de volta).
const PRAZO_LIQUIDAR_S: i64 = 24 * 60 * 60;

// Identificadores (os mesmos do Anchor: sha256("account:<Nome>") e sha256("global:<instrucao>"), 8 bytes)
const DISC_CONFIG: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
const DISC_COFRE: [u8; 8] = [41, 87, 215, 100, 199, 10, 165, 235];
const DISC_PARTIDA: [u8; 8] = [114, 216, 39, 145, 50, 6, 61, 1];
const DISC_SESSAO: [u8; 8] = [211, 152, 49, 13, 218, 150, 171, 252];
const IX_INICIALIZAR: [u8; 8] = [38, 175, 49, 47, 251, 17, 202, 203];
const IX_ATUALIZAR_CONFIG: [u8; 8] = [187, 20, 118, 1, 1, 187, 80, 70];
const IX_PROPOR_ADMIN: [u8; 8] = [177, 96, 12, 200, 84, 6, 28, 2];
const IX_ACEITAR_ADMIN: [u8; 8] = [123, 194, 221, 1, 161, 101, 2, 190];
const IX_ABRIR_COFRE: [u8; 8] = [135, 102, 46, 42, 90, 209, 217, 14];
const IX_DEPOSITAR: [u8; 8] = [207, 16, 199, 114, 220, 5, 105, 219];
const IX_SACAR: [u8; 8] = [104, 250, 109, 216, 146, 245, 119, 217];
const IX_FECHAR_COFRE: [u8; 8] = [118, 217, 51, 140, 37, 60, 187, 195];
const IX_CRIAR_PARTIDA: [u8; 8] = [60, 76, 59, 239, 194, 56, 2, 73];
const IX_ENTRAR_PARTIDA: [u8; 8] = [6, 132, 168, 219, 29, 171, 179, 215];
const IX_LIQUIDAR_PARTIDA: [u8; 8] = [147, 159, 129, 54, 50, 62, 66, 90];
const IX_CANCELAR_PARTIDA: [u8; 8] = [244, 152, 123, 112, 195, 139, 233, 203];
const IX_AUTORIZAR_SESSAO: [u8; 8] = [139, 28, 181, 98, 127, 54, 183, 177];
const IX_REVOGAR_SESSAO: [u8; 8] = [7, 186, 113, 13, 231, 151, 185, 159];
const IX_ENTRAR_PARTIDA_SESSAO: [u8; 8] = [221, 212, 66, 42, 40, 133, 189, 19];
const IX_TRANCAR_SALDO: [u8; 8] = [30, 221, 97, 4, 225, 54, 127, 229];

// Formato das contas (offsets em bytes). Os campos de tamanho variavel ficam no fim, entao todo o resto tem
// posicao fixa e continua legivel pelo formato Borsh descrito no IDL.
// Config: disc | admin | arbitro | carteira_taxas | taxa u16 | teto u64 | pausado | bump | moeda | admin_pendente (1+32)
//         | teto_saldo u64 | teto_total u64 | total_no_cofre u64
// As configs criadas antes dos tetos tem 181 bytes (sem os 3 ultimos = sem teto); crescem no atualizar_config.
const CONFIG_TAM_ANTIGO: usize = 8 + 32 * 3 + 2 + 8 + 1 + 1 + 32 + 33;
const CONFIG_TAM: usize = CONFIG_TAM_ANTIGO + 8 * 3;
// Cofre: disc | dono | saldo u64 | travado u64 | bump | bump_tokens | trancado
// Os cofres abertos antes da trava tem 58 bytes (sem "trancado" = destrancado); crescem ao trancar a primeira vez.
const COFRE_TAM_ANTIGO: usize = 8 + 32 + 8 + 8 + 1 + 1;
const COFRE_TAM: usize = COFRE_TAM_ANTIGO + 1;
// Partida: disc | id | aposta | por_time | entrou | estado | criada_em i64 | pagador | bump | jogadores Vec (max 8)
const PARTIDA_TAM: usize = 8 + 8 + 8 + 1 + 1 + 1 + 8 + 32 + 1 + 4 + 32 * 8;
// Sessao (chave de aposta de um aparelho): disc | dono | chave | criada_em i64 | bump
const SESSAO_TAM: usize = 8 + 32 + 32 + 8 + 1;
const CONTA_TOKEN_TAM: usize = 165;

const ABERTA: u8 = 0;
const TRAVADA: u8 = 1;

/// Erros: mesmos codigos da versao Anchor (6000 + posicao).
#[derive(Clone, Copy)]
enum Erro {
    NaoAutorizado = 6000,
    Pausado,
    ValorInvalido,
    SaldoInsuficiente,
    TaxaAcimaDoTeto,
    ApostaForaDoTeto,
    TimesInvalidos,
    JogadorRepetido,
    NaoEstaNaPartida,
    JaEntrou,
    PrazoEncerrado,
    EstadoInvalido,
    ResultadoInvalido,
    ContasInvalidas,
    CarteiraDeTaxasErrada,
    CofreNaoVazio,
    Overflow,
    MoedaInvalida,
    ApostaDiferente,
    SaldoTrancado,
    AcimaDoTetoDeSaldo,
    CofreCheio,
    AbandonoInvalido,
}
impl From<Erro> for ProgramError {
    fn from(e: Erro) -> Self {
        ProgramError::Custom(e as u32)
    }
}
type R<T> = Result<T, ProgramError>;

fn exigir(condicao: bool, erro: Erro) -> ProgramResult {
    if condicao { Ok(()) } else { Err(erro.into()) }
}

/// Copia N bytes para um array (sem `unwrap`/`copy_from_slice`, que puxam para o binario o codigo de formatacao de
/// mensagens de erro do Rust; o programa fica menor e o deposito na rede, mais barato). Quem chama ja conferiu o tamanho.
fn arr<const N: usize>(s: &[u8]) -> [u8; N] {
    let mut a = [0u8; N];
    for (d, b) in a.iter_mut().zip(s) { *d = *b; }
    a
}

// ---------- Leitura de dados (sempre com o tamanho conferido antes) ----------

/// Le os dados de uma instrucao em sequencia; qualquer leitura alem do fim e erro.
struct Leitor<'a> {
    d: &'a [u8],
    i: usize,
}
impl<'a> Leitor<'a> {
    fn bytes(&mut self, n: usize) -> R<&'a [u8]> {
        let fim = self.i.checked_add(n).ok_or(ProgramError::InvalidInstructionData)?;
        let s = self.d.get(self.i..fim).ok_or(ProgramError::InvalidInstructionData)?;
        self.i = fim;
        Ok(s)
    }
    fn u8(&mut self) -> R<u8> { Ok(self.bytes(1)?[0]) }
    fn u16(&mut self) -> R<u16> { Ok(u16::from_le_bytes(arr(self.bytes(2)?))) }
    fn u32(&mut self) -> R<u32> { Ok(u32::from_le_bytes(arr(self.bytes(4)?))) }
    fn u64(&mut self) -> R<u64> { Ok(u64::from_le_bytes(arr(self.bytes(8)?))) }
    fn chave(&mut self) -> R<Pubkey> { Ok(arr(self.bytes(32)?)) }
    /// Option do Borsh: 0 = nada, 1 = tem valor; qualquer outro byte e invalido.
    fn tem(&mut self) -> R<bool> {
        match self.u8()? { 0 => Ok(false), 1 => Ok(true), _ => Err(ProgramError::InvalidInstructionData) }
    }
    fn fim(&self) -> ProgramResult {
        if self.i == self.d.len() { Ok(()) } else { Err(ProgramError::InvalidInstructionData) }
    }
    /// Ja leu tudo? (campos opcionais no fim, que versoes antigas do servidor nao mandam)
    fn acabou(&self) -> bool { self.i == self.d.len() }
}

fn ler_u64(d: &[u8], i: usize) -> u64 { u64::from_le_bytes(arr(&d[i..i + 8])) }
fn ler_chave(d: &[u8], i: usize) -> Pubkey { arr(&d[i..i + 32]) }
fn gravar_u64(d: &mut [u8], i: usize, v: u64) { d[i..i + 8].copy_from_slice(&v.to_le_bytes()); }

// ---------- Contas do programa ----------

/// Confere que a conta e do programa, tem o identificador certo e o tamanho minimo.
fn conferir_conta(c: &AccountInfo, disc: &[u8; 8], tam: usize) -> ProgramResult {
    exigir(c.is_owned_by(&ID) && c.data_len() >= tam, Erro::ContasInvalidas)?;
    let d = c.try_borrow_data()?;
    exigir(&d[..8] == disc, Erro::ContasInvalidas)
}

struct Config {
    admin: Pubkey,
    arbitro: Pubkey,
    carteira_taxas: Pubkey,
    taxa_partida_bps: u16,
    teto_aposta: u64,
    pausado: bool,
    moeda: Pubkey,
    admin_pendente: Option<Pubkey>,
    /// Maximo (livre + travado) que um cofre pode ter depois de um deposito. 0 = sem teto.
    teto_saldo: u64,
    /// Maximo guardado no programa somando todos os cofres. 0 = sem teto.
    teto_total: u64,
    /// Quanto foi depositado e ainda nao sacado (soma de todos os cofres; conta so a partir dos tetos).
    total_no_cofre: u64,
    /// A conta ja tem o espaco dos tetos (configs antigas tem 181 bytes ate o admin atualizar).
    com_tetos: bool,
}

/// Le a configuracao conferindo dono, identificador e endereco (PDA "config").
fn ler_config(c: &AccountInfo) -> R<Config> {
    conferir_conta(c, &DISC_CONFIG, CONFIG_TAM_ANTIGO)?;
    let d = c.try_borrow_data()?;
    let com_tetos = d.len() >= CONFIG_TAM;
    let bump = [d[115]];
    let esperado = create_program_address(&[b"config".as_ref(), bump.as_ref()], &ID).map_err(|_| Erro::ContasInvalidas)?;
    exigir(&esperado == c.key(), Erro::ContasInvalidas)?;
    Ok(Config {
        admin: ler_chave(&d, 8),
        arbitro: ler_chave(&d, 40),
        carteira_taxas: ler_chave(&d, 72),
        taxa_partida_bps: u16::from_le_bytes([d[104], d[105]]),
        teto_aposta: ler_u64(&d, 106),
        pausado: d[114] == 1,
        moeda: ler_chave(&d, 116),
        admin_pendente: if d[148] == 1 { Some(ler_chave(&d, 149)) } else { None },
        teto_saldo: if com_tetos { ler_u64(&d, 181) } else { 0 },
        teto_total: if com_tetos { ler_u64(&d, 189) } else { 0 },
        total_no_cofre: if com_tetos { ler_u64(&d, 197) } else { 0 },
        com_tetos,
    })
}

fn gravar_config(c: &AccountInfo, cfg: &Config) -> ProgramResult {
    let mut d = c.try_borrow_mut_data()?;
    d[8..40].copy_from_slice(&cfg.admin);
    d[40..72].copy_from_slice(&cfg.arbitro);
    d[72..104].copy_from_slice(&cfg.carteira_taxas);
    d[104..106].copy_from_slice(&cfg.taxa_partida_bps.to_le_bytes());
    gravar_u64(&mut d, 106, cfg.teto_aposta);
    d[114] = cfg.pausado as u8;
    d[116..148].copy_from_slice(&cfg.moeda);
    match cfg.admin_pendente {
        Some(k) => { d[148] = 1; d[149..181].copy_from_slice(&k); }
        None => { d[148] = 0; d[149..181].fill(0); }
    }
    if d.len() >= CONFIG_TAM {
        gravar_u64(&mut d, 181, cfg.teto_saldo);
        gravar_u64(&mut d, 189, cfg.teto_total);
        gravar_u64(&mut d, 197, cfg.total_no_cofre);
    }
    Ok(())
}

struct Cofre {
    saldo: u64,
    travado: u64,
    bump: u8,
    bump_tokens: u8,
    trancado: bool,
}

/// Le o cofre de `dono`, conferindo dono do programa, identificador, endereco (PDA) e o dono gravado.
/// `erro_dono`: qual erro dar se o cofre for de outra pessoa.
fn ler_cofre(c: &AccountInfo, dono: &Pubkey, erro_dono: Erro) -> R<Cofre> {
    conferir_conta(c, &DISC_COFRE, COFRE_TAM_ANTIGO)?;
    let d = c.try_borrow_data()?;
    exigir(&ler_chave(&d, 8) == dono, erro_dono)?;
    let bump = [d[56]];
    let esperado = create_program_address(&[b"cofre".as_ref(), dono.as_ref(), bump.as_ref()], &ID).map_err(|_| Erro::ContasInvalidas)?;
    exigir(&esperado == c.key(), Erro::ContasInvalidas)?;
    let trancado = d.len() > COFRE_TAM_ANTIGO && d[COFRE_TAM_ANTIGO] == 1;
    Ok(Cofre { saldo: ler_u64(&d, 40), travado: ler_u64(&d, 48), bump: d[56], bump_tokens: d[57], trancado })
}

fn gravar_saldos(c: &AccountInfo, cofre: &Cofre) -> ProgramResult {
    let mut d = c.try_borrow_mut_data()?;
    gravar_u64(&mut d, 40, cofre.saldo);
    gravar_u64(&mut d, 48, cofre.travado);
    Ok(())
}

/// Confere que `c` e exatamente a conta de tokens do cofre de `dono` (PDA "tokens").
fn conferir_tokens_do_cofre(c: &AccountInfo, dono: &Pubkey, bump_tokens: u8) -> ProgramResult {
    let bump = [bump_tokens];
    let esperado = create_program_address(&[b"tokens".as_ref(), dono.as_ref(), bump.as_ref()], &ID).map_err(|_| Erro::ContasInvalidas)?;
    exigir(&esperado == c.key() && c.is_writable(), Erro::ContasInvalidas)
}

struct Partida {
    aposta: u64,
    por_time: usize,
    entrou: u8,
    estado: u8,
    criada_em: i64,
    pagador: Pubkey,
    jogadores: [Pubkey; 2 * MAX_POR_TIME],
    n: usize,
}

/// Le a partida conferindo dono do programa, identificador e endereco (PDA "partida" + id).
fn ler_partida(c: &AccountInfo) -> R<Partida> {
    conferir_conta(c, &DISC_PARTIDA, PARTIDA_TAM)?;
    let d = c.try_borrow_data()?;
    let id = ler_u64(&d, 8);
    let bump = [d[67]];
    let id_le = id.to_le_bytes();
    let esperado = create_program_address(&[b"partida".as_ref(), id_le.as_ref(), bump.as_ref()], &ID).map_err(|_| Erro::ContasInvalidas)?;
    exigir(&esperado == c.key(), Erro::ContasInvalidas)?;
    let n = u32::from_le_bytes(arr(&d[68..72])) as usize;
    exigir(n >= 2 && n <= 2 * MAX_POR_TIME, Erro::ContasInvalidas)?;
    let mut jogadores = [[0u8; 32]; 2 * MAX_POR_TIME];
    for (k, j) in jogadores.iter_mut().enumerate().take(n) {
        *j = ler_chave(&d, 72 + 32 * k);
    }
    Ok(Partida {
        aposta: ler_u64(&d, 16),
        por_time: d[24] as usize,
        entrou: d[25],
        estado: d[26],
        criada_em: ler_u64(&d, 27) as i64,
        pagador: ler_chave(&d, 35),
        jogadores,
        n,
    })
}

/// Le a chave de aposta conferindo dono do programa, identificador, endereco (PDA "sessao" + dono + chave) e
/// que `chave` e a chave gravada. Devolve o dono do cofre que autorizou essa chave.
fn ler_sessao(c: &AccountInfo, chave: &Pubkey) -> R<Pubkey> {
    conferir_conta(c, &DISC_SESSAO, SESSAO_TAM)?;
    let d = c.try_borrow_data()?;
    let dono = ler_chave(&d, 8);
    exigir(&ler_chave(&d, 40) == chave, Erro::NaoAutorizado)?;
    let bump = [d[80]];
    let esperado = create_program_address(&[b"sessao".as_ref(), dono.as_ref(), chave.as_ref(), bump.as_ref()], &ID).map_err(|_| Erro::ContasInvalidas)?;
    exigir(&esperado == c.key(), Erro::ContasInvalidas)?;
    Ok(dono)
}

// ---------- Contas de outros programas ----------

/// Conta de tokens SPL (programa de token classico, inicializada): devolve (moeda, dono, saldo).
fn ler_conta_token(c: &AccountInfo) -> R<(Pubkey, Pubkey, u64)> {
    exigir(c.is_owned_by(&TOKEN) && c.data_len() == CONTA_TOKEN_TAM, Erro::ContasInvalidas)?;
    let d = c.try_borrow_data()?;
    exigir(d[108] == 1, Erro::ContasInvalidas)?; // estado: inicializada (nem vazia, nem congelada)
    Ok((ler_chave(&d, 0), ler_chave(&d, 32), ler_u64(&d, 64)))
}

/// Conta de tokens de `dono` na moeda do cofre. Ordem das checagens igual a versao Anchor.
fn conferir_conta_de(c: &AccountInfo, dono: &Pubkey, moeda: &Pubkey, erro_dono: Erro) -> ProgramResult {
    let (m, d, _) = ler_conta_token(c)?;
    exigir(&d == dono, erro_dono)?;
    exigir(&m == moeda, Erro::MoedaInvalida)?;
    exigir(c.is_writable(), Erro::ContasInvalidas)
}

fn conferir_programa(c: &AccountInfo, id: &Pubkey) -> ProgramResult {
    exigir(c.key() == id, Erro::ContasInvalidas)
}

/// Cria uma conta num endereco de programa (PDA), pagando o aluguel. Se alguem ja tiver mandado SOL para o
/// endereco (para tentar travar a criacao), completa o aluguel, aloca e atribui em vez de "criar".
fn criar_pda(pagador: &AccountInfo, conta: &AccountInfo, tam: usize, dono: &Pubkey, sementes: &[Seed]) -> ProgramResult {
    let aluguel = aluguel_minimo(tam)?;
    let assinante = [Signer::from(sementes)];
    let atual = conta.lamports();
    if atual == 0 {
        return CreateAccount { from: pagador, to: conta, lamports: aluguel, space: tam as u64, owner: dono }.invoke_signed(&assinante);
    }
    exigir(conta.is_owned_by(&SISTEMA) && conta.data_len() == 0, Erro::ContasInvalidas)?;
    if atual < aluguel {
        TransferirSol { from: pagador, to: conta, lamports: aluguel - atual }.invoke()?;
    }
    Allocate { account: conta, space: tam as u64 }.invoke_signed(&assinante)?;
    Assign { account: conta, owner: dono }.invoke_signed(&assinante)
}

/// Deposito minimo da rede para a conta nao ser cobrada (mesma conta do Rent::minimum_balance, so com inteiros:
/// o limite de isencao e 2 anos hoje e 1 depois da SIMD-0194; outro valor = erro, nunca um deposito menor).
fn aluguel_minimo(tam: usize) -> R<u64> {
    let r = Rent::get()?;
    let base = (128 + tam as u64).checked_mul(r.lamports_per_byte_year).ok_or(Erro::Overflow)?;
    match r.exemption_threshold.to_bits() {
        0x4000_0000_0000_0000 => base.checked_mul(2).ok_or_else(|| Erro::Overflow.into()), // 2,0
        0x3FF0_0000_0000_0000 => Ok(base), // 1,0
        _ => Err(ProgramError::InvalidAccountData),
    }
}

/// Fecha uma conta do programa: todo o SOL (aluguel) vai para `destino`.
fn fechar_conta(conta: &AccountInfo, destino: &AccountInfo) -> ProgramResult {
    let valor = conta.lamports();
    *destino.try_borrow_mut_lamports()? = destino.lamports().checked_add(valor).ok_or(Erro::Overflow)?;
    *conta.try_borrow_mut_lamports()? = 0;
    conta.close()
}

fn agora() -> R<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Taxa de um par perdedor -> vencedor: `bps` (pontos-base) das duas apostas do par, arredondada para baixo.
/// Somando os pares, da `bps` do pote inteiro. Com bps <= 1000, nunca passa de 20% de uma aposta.
fn taxa_do_par(aposta: u64, bps: u16) -> R<u64> {
    let par = aposta.checked_mul(2).ok_or(Erro::Overflow)?;
    let bps = bps as u64;
    Ok((par / 10_000) * bps + (par % 10_000) * bps / 10_000) // = par * bps / 10000, sem estourar u64
}

// ---------- Entrada ----------

fn processar(programa: &Pubkey, contas: &[AccountInfo], dados: &[u8]) -> ProgramResult {
    exigir(programa == &ID, Erro::ContasInvalidas)?;
    if dados.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, resto) = dados.split_at(8);
    let mut args = Leitor { d: resto, i: 0 };
    let disc: [u8; 8] = arr(disc);
    match disc {
        IX_INICIALIZAR => inicializar(contas, &mut args),
        IX_ATUALIZAR_CONFIG => atualizar_config(contas, &mut args),
        IX_PROPOR_ADMIN => propor_admin(contas, &mut args),
        IX_ACEITAR_ADMIN => aceitar_admin(contas),
        IX_ABRIR_COFRE => abrir_cofre(contas),
        IX_DEPOSITAR => depositar(contas, &mut args),
        IX_SACAR => sacar(contas, &mut args),
        IX_FECHAR_COFRE => fechar_cofre(contas),
        IX_CRIAR_PARTIDA => criar_partida(contas, &mut args),
        IX_ENTRAR_PARTIDA => entrar_partida(contas),
        IX_LIQUIDAR_PARTIDA => liquidar_partida(contas, &mut args),
        IX_CANCELAR_PARTIDA => cancelar_partida(contas),
        IX_AUTORIZAR_SESSAO => autorizar_sessao(contas, &mut args),
        IX_REVOGAR_SESSAO => revogar_sessao(contas),
        IX_ENTRAR_PARTIDA_SESSAO => entrar_partida_sessao(contas, &mut args),
        IX_TRANCAR_SALDO => trancar_saldo(contas, &mut args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- Configuracao ----------

/// Cria a configuracao. So a autoridade de atualizacao do programa pode chamar (evita que um estranho
/// inicialize antes de nos logo depois do deploy). A moeda (mint) fica gravada para sempre.
fn inicializar(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, admin, programa, dados_programa, moeda, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let arbitro = args.chave()?;
    let carteira_taxas = args.chave()?;
    let taxa_partida_bps = args.u16()?;
    let teto_aposta = args.u64()?;
    args.fim()?;
    exigir(admin.is_signer(), Erro::NaoAutorizado)?;
    conferir_programa(sistema, &SISTEMA)?;
    // O programa aponta para os seus dados (ProgramData), e neles esta a autoridade de atualizacao
    exigir(programa.key() == &ID && programa.is_owned_by(&CARREGADOR), Erro::NaoAutorizado)?;
    {
        let d = programa.try_borrow_data()?;
        exigir(d.len() >= 36 && d[..4] == [2, 0, 0, 0] && &d[4..36] == dados_programa.key(), Erro::NaoAutorizado)?;
    }
    exigir(dados_programa.is_owned_by(&CARREGADOR), Erro::NaoAutorizado)?;
    {
        let d = dados_programa.try_borrow_data()?;
        exigir(d.len() >= 45 && d[..4] == [3, 0, 0, 0] && d[12] == 1 && &d[13..45] == admin.key(), Erro::NaoAutorizado)?;
    }
    // A moeda: um mint do programa de token classico, ja inicializado
    exigir(moeda.is_owned_by(&TOKEN) && moeda.data_len() == 82, Erro::MoedaInvalida)?;
    exigir(moeda.try_borrow_data()?[45] == 1, Erro::MoedaInvalida)?;
    exigir(taxa_partida_bps <= TAXA_MAXIMA_BPS, Erro::TaxaAcimaDoTeto)?;
    exigir(teto_aposta > 0, Erro::ValorInvalido)?;

    let (endereco, bump) = find_program_address(&[b"config".as_ref()], &ID);
    exigir(&endereco == config.key(), Erro::ContasInvalidas)?;
    let b = [bump];
    criar_pda(admin, config, CONFIG_TAM, &ID, &[Seed::from(b"config"), Seed::from(&b)])?;
    {
        let mut d = config.try_borrow_mut_data()?;
        d[..8].copy_from_slice(&DISC_CONFIG);
        d[115] = bump;
    }
    gravar_config(config, &Config {
        admin: *admin.key(),
        arbitro,
        carteira_taxas,
        taxa_partida_bps,
        teto_aposta,
        pausado: false,
        moeda: *moeda.key(),
        admin_pendente: None,
        teto_saldo: 0,
        teto_total: 0,
        total_no_cofre: 0,
        com_tetos: true,
    })
}

/// Admin muda parametros. A taxa nunca passa do teto; pausar NAO bloqueia saques; a moeda nao muda.
fn atualizar_config(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, admin, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let mut cfg = ler_config(config)?;
    exigir(admin.is_signer() && admin.key() == &cfg.admin, Erro::NaoAutorizado)?;
    if args.tem()? { cfg.arbitro = args.chave()?; }
    if args.tem()? { cfg.carteira_taxas = args.chave()?; }
    if args.tem()? {
        let v = args.u16()?;
        exigir(v <= TAXA_MAXIMA_BPS, Erro::TaxaAcimaDoTeto)?;
        cfg.taxa_partida_bps = v;
    }
    if args.tem()? {
        let v = args.u64()?;
        exigir(v > 0, Erro::ValorInvalido)?;
        cfg.teto_aposta = v;
    }
    if args.tem()? {
        cfg.pausado = match args.u8()? { 0 => false, 1 => true, _ => return Err(ProgramError::InvalidInstructionData) };
    }
    // Tetos de deposito (0 = sem teto)
    if args.tem()? { cfg.teto_saldo = args.u64()?; }
    if args.tem()? { cfg.teto_total = args.u64()?; }
    args.fim()?;
    // Config antiga: cresce para caber os tetos (o admin completa o aluguel)
    if !cfg.com_tetos {
        conferir_programa(sistema, &SISTEMA)?;
        let aluguel = aluguel_minimo(CONFIG_TAM)?;
        let atual = config.lamports();
        if atual < aluguel {
            TransferirSol { from: admin, to: config, lamports: aluguel - atual }.invoke()?;
        }
        config.resize(CONFIG_TAM)?;
    }
    gravar_config(config, &cfg)
}

/// Troca de admin em duas etapas: o atual propoe, o novo aceita (evita entregar para um endereco errado).
fn propor_admin(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, admin, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let novo = args.chave()?;
    args.fim()?;
    let mut cfg = ler_config(config)?;
    exigir(admin.is_signer() && admin.key() == &cfg.admin, Erro::NaoAutorizado)?;
    cfg.admin_pendente = Some(novo);
    gravar_config(config, &cfg)
}

fn aceitar_admin(contas: &[AccountInfo]) -> ProgramResult {
    let [config, novo_admin, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let mut cfg = ler_config(config)?;
    exigir(novo_admin.is_signer() && cfg.admin_pendente == Some(*novo_admin.key()), Erro::NaoAutorizado)?;
    cfg.admin = *novo_admin.key();
    cfg.admin_pendente = None;
    gravar_config(config, &cfg)
}

// ---------- Cofre do jogador ----------

/// O jogador abre o proprio cofre e a conta de tokens dele (paga o aluguel, que volta ao fechar).
fn abrir_cofre(contas: &[AccountInfo]) -> ProgramResult {
    let [config, cofre, tokens, moeda, dono, programa_token, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let cfg = ler_config(config)?;
    exigir(moeda.key() == &cfg.moeda, Erro::MoedaInvalida)?;
    exigir(dono.is_signer(), Erro::NaoAutorizado)?;
    conferir_programa(programa_token, &TOKEN)?;
    conferir_programa(sistema, &SISTEMA)?;
    let (end_cofre, bump) = find_program_address(&[b"cofre".as_ref(), dono.key().as_ref()], &ID);
    let (end_tokens, bump_tokens) = find_program_address(&[b"tokens".as_ref(), dono.key().as_ref()], &ID);
    exigir(&end_cofre == cofre.key() && &end_tokens == tokens.key(), Erro::ContasInvalidas)?;

    let b = [bump];
    criar_pda(dono, cofre, COFRE_TAM, &ID, &[Seed::from(b"cofre"), Seed::from(dono.key()), Seed::from(&b)])?;
    let bt = [bump_tokens];
    criar_pda(dono, tokens, CONTA_TOKEN_TAM, &TOKEN, &[Seed::from(b"tokens"), Seed::from(dono.key()), Seed::from(&bt)])?;
    InitializeAccount3 { account: tokens, mint: moeda, owner: cofre.key() }.invoke()?;

    let mut d = cofre.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC_COFRE);
    d[8..40].copy_from_slice(dono.key());
    gravar_u64(&mut d, 40, 0);
    gravar_u64(&mut d, 48, 0);
    d[56] = bump;
    d[57] = bump_tokens;
    d[58] = 0; // destrancado: o saldo todo fica disponivel para apostar (padrao)
    Ok(())
}

/// Deposito: USDC sai de uma conta de tokens do dono (que assina) para o cofre dele. Sem taxa.
fn depositar(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, cofre, tokens, origem, dono, programa_token, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let valor = args.u64()?;
    args.fim()?;
    let mut cfg = ler_config(config)?;
    let mut c = ler_cofre(cofre, dono.key(), Erro::NaoAutorizado)?;
    conferir_tokens_do_cofre(tokens, dono.key(), c.bump_tokens)?;
    conferir_conta_de(origem, dono.key(), &cfg.moeda, Erro::NaoAutorizado)?;
    exigir(dono.is_signer(), Erro::NaoAutorizado)?;
    conferir_programa(programa_token, &TOKEN)?;
    exigir(!cfg.pausado, Erro::Pausado)?;
    exigir(valor > 0, Erro::ValorInvalido)?;
    let novo_saldo = c.saldo.checked_add(valor).ok_or(Erro::Overflow)?;
    let novo_total = cfg.total_no_cofre.checked_add(valor).ok_or(Erro::Overflow)?;
    exigir(cfg.teto_saldo == 0 || novo_saldo.checked_add(c.travado).ok_or(Erro::Overflow)? <= cfg.teto_saldo, Erro::AcimaDoTetoDeSaldo)?;
    exigir(cfg.teto_total == 0 || novo_total <= cfg.teto_total, Erro::CofreCheio)?;

    Transfer { from: origem, to: tokens, authority: dono, amount: valor }.invoke()?;
    c.saldo = novo_saldo;
    gravar_saldos(cofre, &c)?;
    if cfg.com_tetos {
        cfg.total_no_cofre = novo_total;
        gravar_config(config, &cfg)?;
    }
    Ok(())
}

/// Saque: so o dono assina e o valor vai inteiro so para uma conta de tokens dele (sem taxa). Funciona mesmo com o
/// programa pausado.
fn sacar(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, cofre, tokens, destino, dono, programa_token, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let valor = args.u64()?;
    args.fim()?;
    let mut cfg = ler_config(config)?;
    let mut c = ler_cofre(cofre, dono.key(), Erro::NaoAutorizado)?;
    conferir_tokens_do_cofre(tokens, dono.key(), c.bump_tokens)?;
    conferir_conta_de(destino, dono.key(), &cfg.moeda, Erro::NaoAutorizado)?;
    exigir(dono.is_signer(), Erro::NaoAutorizado)?;
    conferir_programa(programa_token, &TOKEN)?;
    exigir(valor > 0, Erro::ValorInvalido)?;
    exigir(c.saldo >= valor, Erro::SaldoInsuficiente)?;

    c.saldo -= valor;
    gravar_saldos(cofre, &c)?;
    if cfg.com_tetos {
        cfg.total_no_cofre = cfg.total_no_cofre.saturating_sub(valor);
        gravar_config(config, &cfg)?;
    }

    let b = [c.bump];
    let sementes = [Seed::from(b"cofre"), Seed::from(dono.key()), Seed::from(&b)];
    let assinante = [Signer::from(&sementes)];
    Transfer { from: tokens, to: destino, authority: cofre, amount: valor }.invoke_signed(&assinante)
}

/// Fecha o cofre vazio: qualquer sobra de tokens (ex.: enviada direto por alguem) vai para o dono,
/// a conta de tokens e fechada e o aluguel das duas contas volta ao dono.
fn fechar_cofre(contas: &[AccountInfo]) -> ProgramResult {
    let [config, cofre, tokens, destino, dono, programa_token, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let cfg = ler_config(config)?;
    let c = ler_cofre(cofre, dono.key(), Erro::NaoAutorizado)?;
    exigir(c.saldo == 0 && c.travado == 0, Erro::CofreNaoVazio)?;
    conferir_tokens_do_cofre(tokens, dono.key(), c.bump_tokens)?;
    conferir_conta_de(destino, dono.key(), &cfg.moeda, Erro::NaoAutorizado)?;
    exigir(dono.is_signer() && dono.is_writable(), Erro::NaoAutorizado)?;
    conferir_programa(programa_token, &TOKEN)?;

    let (_, _, sobra) = ler_conta_token(tokens)?;
    let b = [c.bump];
    let sementes = [Seed::from(b"cofre"), Seed::from(dono.key()), Seed::from(&b)];
    let assinante = [Signer::from(&sementes)];
    if sobra > 0 {
        Transfer { from: tokens, to: destino, authority: cofre, amount: sobra }.invoke_signed(&assinante)?;
    }
    CloseAccount { account: tokens, destination: dono, authority: cofre }.invoke_signed(&assinante)?;
    fechar_conta(cofre, dono)
}

// ---------- Chave de aposta (aposta sem abrir a wallet a cada partida) ----------

/// O dono autoriza uma chave de aposta (gerada no navegador dele) e paga o aluguel, que volta ao revogar.
/// Pode ter varias (uma por aparelho).
fn autorizar_sessao(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [sessao, dono, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let chave = args.chave()?;
    args.fim()?;
    exigir(dono.is_signer() && dono.is_writable(), Erro::NaoAutorizado)?;
    exigir(&chave != dono.key(), Erro::ValorInvalido)?;
    conferir_programa(sistema, &SISTEMA)?;
    let (endereco, bump) = find_program_address(&[b"sessao".as_ref(), dono.key().as_ref(), chave.as_ref()], &ID);
    exigir(&endereco == sessao.key(), Erro::ContasInvalidas)?;
    let b = [bump];
    criar_pda(dono, sessao, SESSAO_TAM, &ID, &[Seed::from(b"sessao"), Seed::from(dono.key()), Seed::from(&chave), Seed::from(&b)])?;
    let mut d = sessao.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC_SESSAO);
    d[8..40].copy_from_slice(dono.key());
    d[40..72].copy_from_slice(&chave);
    gravar_u64(&mut d, 72, agora()? as u64);
    d[80] = bump;
    Ok(())
}

/// Revoga a chave de aposta. Assina o dono (pela wallet) ou a propria chave (ao sair do aparelho);
/// o aluguel volta sempre para o dono.
fn revogar_sessao(contas: &[AccountInfo]) -> ProgramResult {
    let [sessao, dono, quem, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    conferir_conta(sessao, &DISC_SESSAO, SESSAO_TAM)?;
    let chave = ler_chave(&sessao.try_borrow_data()?, 40);
    let dono_gravado = ler_sessao(sessao, &chave)?;
    exigir(dono.key() == &dono_gravado && dono.is_writable(), Erro::ContasInvalidas)?;
    exigir(quem.is_signer() && (quem.key() == &dono_gravado || quem.key() == &chave), Erro::NaoAutorizado)?;
    fechar_conta(sessao, dono)
}

/// A chave de aposta trava a aposta do dono dela. `aposta` tem de ser o valor da partida: o navegador so assina
/// o valor que o jogador escolheu, entao o servidor nao consegue trocar por outro.
fn entrar_partida_sessao(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, partida, cofre, sessao, chave, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let aposta = args.u64()?;
    args.fim()?;
    exigir(chave.is_signer(), Erro::NaoAutorizado)?;
    let dono = ler_sessao(sessao, chave.key())?;
    exigir(!ler_cofre(cofre, &dono, Erro::NaoAutorizado)?.trancado, Erro::SaldoTrancado)?;
    travar_aposta(config, partida, cofre, &dono, Some(aposta))
}

/// O dono tranca (1) ou destranca (0) o saldo, assinando com a wallet. Trancado, nenhuma chave de aposta aposta;
/// o saque continua normal. Cofre antigo (58 bytes) cresce 1 byte, e o dono completa o aluguel.
fn trancar_saldo(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [cofre, dono, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let trancar = match args.u8()? { 0 => false, 1 => true, _ => return Err(ProgramError::InvalidInstructionData) };
    args.fim()?;
    ler_cofre(cofre, dono.key(), Erro::NaoAutorizado)?;
    exigir(dono.is_signer() && cofre.is_writable(), Erro::NaoAutorizado)?;
    conferir_programa(sistema, &SISTEMA)?;
    if cofre.data_len() < COFRE_TAM {
        let aluguel = aluguel_minimo(COFRE_TAM)?;
        let atual = cofre.lamports();
        if atual < aluguel {
            TransferirSol { from: dono, to: cofre, lamports: aluguel - atual }.invoke()?;
        }
        cofre.resize(COFRE_TAM)?;
    }
    cofre.try_borrow_mut_data()?[COFRE_TAM_ANTIGO] = trancar as u8;
    Ok(())
}

// ---------- Partidas ----------

/// O arbitro cria a partida com os times e o valor por jogador (dentro do teto).
fn criar_partida(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, partida, arbitro, sistema, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let cfg = ler_config(config)?;
    exigir(arbitro.is_signer() && arbitro.key() == &cfg.arbitro, Erro::NaoAutorizado)?;
    conferir_programa(sistema, &SISTEMA)?;
    let id = args.u64()?;
    let aposta = args.u64()?;
    let mut jogadores = [[0u8; 32]; 2 * MAX_POR_TIME];
    let na = args.u32()? as usize;
    exigir(na >= 1 && na <= MAX_POR_TIME, Erro::TimesInvalidos)?;
    for j in jogadores.iter_mut().take(na) { *j = args.chave()?; }
    let nb = args.u32()? as usize;
    exigir(nb == na, Erro::TimesInvalidos)?;
    for j in jogadores.iter_mut().skip(na).take(nb) { *j = args.chave()?; }
    args.fim()?;
    exigir(!cfg.pausado, Erro::Pausado)?;
    exigir(aposta > 0 && aposta <= cfg.teto_aposta, Erro::ApostaForaDoTeto)?;
    let n = na + nb;
    for i in 0..n {
        for k in (i + 1)..n {
            exigir(jogadores[i] != jogadores[k], Erro::JogadorRepetido)?;
        }
    }
    let id_le = id.to_le_bytes();
    let (endereco, bump) = find_program_address(&[b"partida".as_ref(), id_le.as_ref()], &ID);
    exigir(&endereco == partida.key(), Erro::ContasInvalidas)?;
    let b = [bump];
    criar_pda(arbitro, partida, PARTIDA_TAM, &ID, &[Seed::from(b"partida"), Seed::from(&id_le), Seed::from(&b)])?;

    let mut d = partida.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&DISC_PARTIDA);
    gravar_u64(&mut d, 8, id);
    gravar_u64(&mut d, 16, aposta);
    d[24] = na as u8;
    d[25] = 0;
    d[26] = ABERTA;
    gravar_u64(&mut d, 27, agora()? as u64);
    d[35..67].copy_from_slice(arbitro.key());
    d[67] = bump;
    d[68..72].copy_from_slice(&(n as u32).to_le_bytes());
    for (k, j) in jogadores.iter().enumerate().take(n) {
        d[72 + 32 * k..104 + 32 * k].copy_from_slice(j);
    }
    Ok(())
}

/// O jogador trava a propria aposta, assinando com a propria carteira. Sem essa assinatura nada e travado.
fn entrar_partida(contas: &[AccountInfo]) -> ProgramResult {
    let [config, partida, cofre, jogador, ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    exigir(jogador.is_signer(), Erro::NaoAutorizado)?;
    travar_aposta(config, partida, cofre, jogador.key(), None)
}

/// Trava a aposta da partida no cofre de `jogador` (quem chama ja conferiu a assinatura dele ou da chave de aposta).
fn travar_aposta(config: &AccountInfo, partida: &AccountInfo, cofre: &AccountInfo, jogador: &Pubkey, aposta_esperada: Option<u64>) -> ProgramResult {
    let cfg = ler_config(config)?;
    let mut p = ler_partida(partida)?;
    let mut c = ler_cofre(cofre, jogador, Erro::NaoAutorizado)?;
    if let Some(v) = aposta_esperada {
        exigir(v == p.aposta, Erro::ApostaDiferente)?;
    }
    exigir(!cfg.pausado, Erro::Pausado)?;
    exigir(p.estado == ABERTA, Erro::EstadoInvalido)?;
    exigir(agora()? <= p.criada_em + PRAZO_ENTRAR_S, Erro::PrazoEncerrado)?;
    let i = p.jogadores[..p.n].iter().position(|j| j == jogador).ok_or(Erro::NaoEstaNaPartida)?;
    exigir(p.entrou & (1 << i) == 0, Erro::JaEntrou)?;
    exigir(c.saldo >= p.aposta, Erro::SaldoInsuficiente)?;
    c.saldo -= p.aposta;
    c.travado = c.travado.checked_add(p.aposta).ok_or(Erro::Overflow)?;
    p.entrou |= 1 << i;
    if p.entrou.count_ones() as usize == p.n {
        p.estado = TRAVADA;
    }
    gravar_saldos(cofre, &c)?;
    let mut d = partida.try_borrow_mut_data()?;
    d[25] = p.entrou;
    d[26] = p.estado;
    Ok(())
}

/// O arbitro informa o resultado (0 = empate, 1 = time A, 2 = time B) e, se houver, quem ABANDONOU a partida
/// (Option<u8>: bit i = jogador i, na ordem da partida; versoes antigas do servidor nao mandam). Contas restantes:
/// para CADA jogador, na ordem da partida, o cofre e a conta de tokens dele (2 por jogador); por ultimo, se houver
/// taxa (resultado com vencedor e taxa > 0) ou abandono, a conta de tokens da carteira de taxas (e a configuracao
/// gravavel: o total guardado diminui). Cada perdedor perde a aposta; cada vencedor recebe a dele de volta mais a
/// aposta do perdedor correspondente menos a taxa (regra 6: taxa = porcentagem das duas apostas desse par, ou seja,
/// do pote). No empate todos recebem de volta, sem taxa. Pool de abandono (regra 4b): quem abandonou nao recebe nada;
/// o que ele receberia vai para a carteira de taxas; os outros recebem o mesmo. Fora isso, nada sai do grupo.
fn liquidar_partida(contas: &[AccountInfo], args: &mut Leitor) -> ProgramResult {
    let [config, partida, arbitro, pagador, programa_token, restantes @ ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let resultado = args.u8()?;
    let abandonos = if args.acabou() { 0 } else if args.tem()? { args.u8()? } else { 0 };
    args.fim()?;
    let mut cfg = ler_config(config)?;
    exigir(arbitro.is_signer() && arbitro.key() == &cfg.arbitro, Erro::NaoAutorizado)?;
    let p = ler_partida(partida)?;
    exigir(pagador.key() == &p.pagador, Erro::ContasInvalidas)?;
    conferir_programa(programa_token, &TOKEN)?;
    exigir(resultado <= 2, Erro::ResultadoInvalido)?;
    exigir(p.estado == TRAVADA, Erro::EstadoInvalido)?;
    // Abandono: so jogadores desta partida e nunca todos (todo mundo saindo nao tem resultado: o servidor cancela)
    exigir((abandonos as u32) >> p.n == 0 && (abandonos.count_ones() as usize) < p.n, Erro::AbandonoInvalido)?;
    let com_abandono = abandonos != 0;
    // Taxa de cada par perdedor -> vencedor (0 no empate): porcentagem das duas apostas do par
    let taxa_par = if resultado == 0 { 0 } else { taxa_do_par(p.aposta, cfg.taxa_partida_bps)? };
    let com_taxas = com_abandono || taxa_par > 0;
    exigir(restantes.len() == 2 * p.n + com_taxas as usize, Erro::ContasInvalidas)?;
    let taxas = if com_taxas {
        let t = &restantes[2 * p.n];
        conferir_conta_de(t, &cfg.carteira_taxas, &cfg.moeda, Erro::CarteiraDeTaxasErrada)?;
        Some(t)
    } else { None };
    let abandonou = |i: usize| abandonos & (1u8 << i) != 0;
    let venceu = |i: usize| { let do_a = i < p.por_time; (resultado == 1 && do_a) || (resultado == 2 && !do_a) };

    // 1. Contabilidade: confere cada cofre e a conta de tokens dele e atualiza os saldos
    let mut bumps = [0u8; 2 * MAX_POR_TIME];
    let mut para_pool: u64 = 0;
    for i in 0..p.n {
        let (cofre, tokens) = (&restantes[2 * i], &restantes[2 * i + 1]);
        exigir(cofre.is_writable(), Erro::ContasInvalidas)?;
        let mut c = ler_cofre(cofre, &p.jogadores[i], Erro::ContasInvalidas)?;
        conferir_tokens_do_cofre(tokens, &p.jogadores[i], c.bump_tokens)?;
        c.travado = c.travado.checked_sub(p.aposta).ok_or(Erro::Overflow)?;
        // Vencedor: a propria aposta + a do perdedor do par - a taxa do par (taxa_par <= 10% de 2 apostas < 1 aposta)
        let ganho = if resultado == 0 { p.aposta }
            else if venceu(i) { p.aposta.checked_mul(2).and_then(|v| v.checked_sub(taxa_par)).ok_or(Erro::Overflow)? }
            else { 0 };
        // Quem abandonou nao recebe: a parte dele vai para a pool de abandono
        if abandonou(i) { para_pool = para_pool.checked_add(ganho).ok_or(Erro::Overflow)?; }
        else { c.saldo = c.saldo.checked_add(ganho).ok_or(Erro::Overflow)?; }
        gravar_saldos(cofre, &c)?;
        bumps[i] = c.bump;
    }
    // A taxa e a pool saem do programa: o total guardado diminui
    let taxa_total = if resultado == 0 { 0 } else { taxa_par.checked_mul(p.por_time as u64).ok_or(Erro::Overflow)? };
    let sai = para_pool.checked_add(taxa_total).ok_or(Erro::Overflow)?;
    if sai > 0 && cfg.com_tetos {
        exigir(config.is_writable(), Erro::ContasInvalidas)?; // com taxa ou abandono a configuracao vem gravavel
        cfg.total_no_cofre = cfg.total_no_cofre.saturating_sub(sai);
        gravar_config(config, &cfg)?;
    }
    // 2. Tokens: cada perdedor manda a aposta para o vencedor correspondente (times do mesmo tamanho), menos a taxa
    //    do par, que vai para a carteira de taxas; se esse vencedor abandonou, a aposta inteira vai para a carteira
    //    de taxas (taxa + pool)
    if resultado != 0 {
        let (perdedores, vencedores) = if resultado == 1 { (p.por_time..p.n, 0..p.por_time) } else { (0..p.por_time, p.por_time..p.n) };
        for (l, w) in perdedores.zip(vencedores) {
            let b = [bumps[l]];
            let sementes = [Seed::from(b"cofre"), Seed::from(&p.jogadores[l]), Seed::from(&b)];
            let (de, autoridade) = (&restantes[2 * l + 1], &restantes[2 * l]);
            if abandonou(w) {
                Transfer { from: de, to: taxas.ok_or(Erro::ContasInvalidas)?, authority: autoridade, amount: p.aposta }
                    .invoke_signed(&[Signer::from(&sementes)])?;
                continue;
            }
            Transfer { from: de, to: &restantes[2 * w + 1], authority: autoridade, amount: p.aposta.checked_sub(taxa_par).ok_or(Erro::Overflow)? }
                .invoke_signed(&[Signer::from(&sementes)])?;
            if taxa_par > 0 {
                Transfer { from: de, to: taxas.ok_or(Erro::ContasInvalidas)?, authority: autoridade, amount: taxa_par }
                    .invoke_signed(&[Signer::from(&sementes)])?;
            }
        }
    }
    // 3. Pool: quem abandonou e receberia algo (venceu ou empatou) manda a propria aposta para a carteira de taxas
    if let Some(t) = taxas {
        for i in 0..p.n {
            if !abandonou(i) || (resultado != 0 && !venceu(i)) { continue; }
            let b = [bumps[i]];
            let sementes = [Seed::from(b"cofre"), Seed::from(&p.jogadores[i]), Seed::from(&b)];
            Transfer { from: &restantes[2 * i + 1], to: t, authority: &restantes[2 * i], amount: p.aposta }
                .invoke_signed(&[Signer::from(&sementes)])?;
        }
    }
    fechar_conta(partida, pagador)
}

/// Cancela e devolve as apostas travadas. Pode chamar: o arbitro a qualquer momento; qualquer um se a
/// partida nao encheu no prazo de entrada; qualquer um se nao foi liquidada no prazo de liquidacao.
/// Contas restantes: os cofres dos jogadores que ja entraram, na ordem da partida (os tokens nao se movem).
fn cancelar_partida(contas: &[AccountInfo]) -> ProgramResult {
    let [config, partida, quem, pagador, restantes @ ..] = contas else { return Err(ProgramError::NotEnoughAccountKeys) };
    let cfg = ler_config(config)?;
    let p = ler_partida(partida)?;
    exigir(pagador.key() == &p.pagador, Erro::ContasInvalidas)?;
    exigir(quem.is_signer(), Erro::NaoAutorizado)?;
    exigir(p.estado == ABERTA || p.estado == TRAVADA, Erro::EstadoInvalido)?;
    let t = agora()?;
    let eh_arbitro = quem.key() == &cfg.arbitro;
    let entrada_vencida = p.estado == ABERTA && t > p.criada_em + PRAZO_ENTRAR_S;
    let liquidacao_vencida = t > p.criada_em + PRAZO_LIQUIDAR_S;
    exigir(eh_arbitro || entrada_vencida || liquidacao_vencida, Erro::NaoAutorizado)?;

    let entraram = p.entrou.count_ones() as usize;
    exigir(restantes.len() == entraram, Erro::ContasInvalidas)?;
    let mut k = 0;
    for i in 0..p.n {
        if p.entrou & (1 << i) == 0 {
            continue;
        }
        let cofre = &restantes[k];
        exigir(cofre.is_writable(), Erro::ContasInvalidas)?;
        let mut c = ler_cofre(cofre, &p.jogadores[i], Erro::ContasInvalidas)?;
        c.travado = c.travado.checked_sub(p.aposta).ok_or(Erro::Overflow)?;
        c.saldo = c.saldo.checked_add(p.aposta).ok_or(Erro::Overflow)?;
        gravar_saldos(cofre, &c)?;
        k += 1;
    }
    fechar_conta(partida, pagador)
}
