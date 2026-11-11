export async function sendMail(config, body) {
  if (config.host !== 'smtp.fixture.invalid') throw new Error('Task5 SMTP fixture denied');
  globalThis.task5Sends.push({ type: 'smtp', body });
}
