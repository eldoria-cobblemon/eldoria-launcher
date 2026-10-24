// Zip determinístico (mesma pasta = mesmo arquivo, byte a byte), sem dependências.
// Assim o resourcepack só muda de hash quando o conteúdo muda de verdade,
// e o jogador não baixa 100+ MB à toa.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function listar(raiz) {
    const saida = []
    const andar = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name)
            if (e.isDirectory()) andar(abs)
            else if (e.isFile()) saida.push(path.relative(raiz, abs).split(path.sep).join('/'))
        }
    }
    andar(raiz)
    return saida.sort()
}

// O que entra no zip de um resourcepack: só o que o jogo lê. Pasta de ferramenta/rascunho (_*, mods_cliente/,
// .github/ do repo da Angela) e .bbmodel ficam de fora. Publicador e GitHub Action usam a mesma regra.
const RAIZ_PACK = new Set(['assets', 'data', 'pack.mcmeta', 'pack.png'])
export function ignorarPack(nome) {
    return !RAIZ_PACK.has(nome.split('/')[0]) || nome.endsWith('.bbmodel')
}

// Data fixa (1/1/2020 00:00) em formato DOS.
const HORA_DOS = 0
const DATA_DOS = ((2020 - 1980) << 9) | (1 << 5) | 1

export function zipDePasta(pasta, destino, ignorar = () => false) {
    const nomes = listar(pasta).filter((n) => !ignorar(n))
    const fd = fs.openSync(destino, 'w')
    const central = []
    let pos = 0
    const escrever = (buf) => { fs.writeSync(fd, buf); pos += buf.length }

    for (const nome of nomes) {
        const dados = fs.readFileSync(path.join(pasta, ...nome.split('/')))
        const comprimido = zlib.deflateRawSync(dados, { level: 9 })
        const usarDeflate = comprimido.length < dados.length
        const corpo = usarDeflate ? comprimido : dados
        const crc = zlib.crc32(dados)
        const nomeBuf = Buffer.from(nome, 'utf8')
        const offset = pos

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
        local.writeUInt16LE(usarDeflate ? 8 : 0, 8)
        local.writeUInt16LE(HORA_DOS, 10)
        local.writeUInt16LE(DATA_DOS, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(corpo.length, 18)
        local.writeUInt32LE(dados.length, 22)
        local.writeUInt16LE(nomeBuf.length, 26)
        local.writeUInt16LE(0, 28)
        escrever(local); escrever(nomeBuf); escrever(corpo)

        const c = Buffer.alloc(46)
        c.writeUInt32LE(0x02014b50, 0)
        c.writeUInt16LE(20, 4)
        c.writeUInt16LE(20, 6)
        c.writeUInt16LE(0x0800, 8)
        c.writeUInt16LE(usarDeflate ? 8 : 0, 10)
        c.writeUInt16LE(HORA_DOS, 12)
        c.writeUInt16LE(DATA_DOS, 14)
        c.writeUInt32LE(crc, 16)
        c.writeUInt32LE(corpo.length, 20)
        c.writeUInt32LE(dados.length, 24)
        c.writeUInt16LE(nomeBuf.length, 28)
        c.writeUInt32LE(offset, 42)
        central.push(c, nomeBuf)
    }

    const inicioCentral = pos
    for (const b of central) escrever(b)
    const fim = Buffer.alloc(22)
    fim.writeUInt32LE(0x06054b50, 0)
    fim.writeUInt16LE(nomes.length, 8)
    fim.writeUInt16LE(nomes.length, 10)
    fim.writeUInt32LE(pos - inicioCentral, 12)
    fim.writeUInt32LE(inicioCentral, 16)
    escrever(fim)
    fs.closeSync(fd)
    if (nomes.length > 0xffff || pos > 0xffffffff) throw new Error('Zip grande demais pro formato simples (precisaria de zip64)')
    return nomes.length
}
