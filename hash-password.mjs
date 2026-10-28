import { randomBytes, scryptSync } from 'node:crypto';
import readline from 'node:readline';

if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  console.error('Ejecuta `npm run auth:hash` desde una terminal interactiva.');
  process.exit(1);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('Contraseña (entrada oculta): ');

let password = '';
let done = false;
process.stdin.on('keypress', (character, key) => {
  if (done) return;
  if (key?.ctrl && key.name === 'c') {
    done = true;
    process.stdin.setRawMode(false);
    process.stdout.write('\nCancelado.\n');
    process.exit(130);
  }
  if (key?.name === 'return' || key?.name === 'enter') {
    done = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    if (!password) {
      console.error('La contraseña no puede estar vacía.');
      process.exit(1);
    }
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    password = '';
    console.log(`scrypt$32768$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`);
    process.exit(0);
  }
  if (key?.name === 'backspace') {
    password = Array.from(password).slice(0, -1).join('');
  } else if (!key?.ctrl && !key?.meta && character) {
    password += character;
  }
});
