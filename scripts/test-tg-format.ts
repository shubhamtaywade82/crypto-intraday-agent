// Smoke test: build messages and dump text + entities to validate tg-format usage.
import {
  fmt, bold, italic, code, pre, link, quote,
} from '@nemesis-oss/tg-format'

const entry = fmt`🟢 ${bold('Position opened')} · ${code('BTCUSDT')}
${bold('Side')}: ${bold('▲ LONG')}   ${bold('Qty')}: ${code('0.123456')}
${bold('Entry')}: ${code('42500.0000')}   ${bold('Stop')}: ${code('42000.0000')}   ${bold('TP')}: ${code('43500.0000')}
${bold('Risk')}: ${code('200.00 USDT')}   ${bold('R:R')}: ${code('2.00')}   ${bold('Conf')}: ${code('78%')}
${bold('Strategy')}: ${code('llm-confluence')}
${italic('Thesis')}: momentum EMA9 crossed above EMA21 with volume expansion; OI up 1.8% confirms.`

console.log('--- TEXT ---')
console.log(entry.text)
console.log('--- ENTITIES (count=' + entry.entities.length + ') ---')
for (const e of entry.entities) console.log(JSON.stringify(e))
console.log('--- HTML ---')
console.log(entry.toHTML())
console.log('--- LENGTH: ' + entry.text.length + ' UTF-16 units ---')

const exit = fmt`🔴 ${bold('Position closed')} · ${code('BTCUSDT')}
${bold('PnL')}: ${bold('+432.50 USDT')} (${code('+8.20%')})`
console.log('--- EXIT TEXT ---')
console.log(exit.text)
console.log('--- EXIT ENTITIES ---')
for (const e of exit.entities) console.log(JSON.stringify(e))

const halt = fmt`⚠️ ${bold('TRADING HALTED')}
daily loss cutoff hit (-3.10% < -3%)
${bold('Daily PnL')}: ${bold('-310.00 USDT')} (${code('-3.10%')})`
console.log('--- HALT TEXT ---')
console.log(halt.text)
