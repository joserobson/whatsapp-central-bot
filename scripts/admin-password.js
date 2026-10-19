import { emitKeypressEvents } from 'node:readline';
import { hashPassword } from '../src/admin/auth.js';

if (!process.stdin.isTTY) throw new Error('Execute em um terminal interativo.');
emitKeypressEvents(process.stdin);
const readSecret = prompt => new Promise((resolve, reject) => {
  let value = '';
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const finish = () => { process.stdin.off('keypress', handle); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
  function handle(text, key) {
    if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Cancelado')); }
    else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(value); }
    else if (key.name === 'backspace') value = value.slice(0, -1);
    else if (text && !key.ctrl && !key.meta && value.length < 256) value += text;
  }
  process.stdin.on('keypress', handle);
});
const password = await readSecret('Senha administrativa (12–256 caracteres, entrada oculta): ');
const confirmation = await readSecret('Confirme a senha: ');
if (password !== confirmation) throw new Error('As senhas não coincidem.');
console.log(`ADMIN_PASSWORD_HASH_B64=${Buffer.from(await hashPassword(password)).toString('base64')}`);
