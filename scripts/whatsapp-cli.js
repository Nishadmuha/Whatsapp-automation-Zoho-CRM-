'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const dotenv = require('dotenv');
const {
  createWhatsAppService, readWhatsAppSendConfig, validateTextMessage, validateTemplateMessage,
} = require('../src/services/whatsapp/whatsappService');
const { maskPhone } = require('../src/utils/logger');

const USAGE = [
  'npm.cmd run whatsapp:test -- [--send] [--template hello_world] [--language en_US]',
  'The default is a dry run. Only --send makes one request to Meta; there are no retries.',
  'Supply WHATSAPP_TEST_TO in your private environment, or enter the recipient at the local prompt.',
  'Optional --to NUMBER is supported, but the environment or prompt avoids putting the number in shell history.',
  'Use --mode text and WHATSAPP_TEST_TEXT or the local prompt for a text message; --text TEXT is also supported.',
  'Text messages require an open customer service window. Use an approved template and its exact language for template sends.',
];
const ERROR_MESSAGES = {
  ERR_WHATSAPP_CONFIG: 'Set a valid WhatsApp access token, numeric phone number ID, and Graph API version in the local environment.',
  ERR_WHATSAPP_INPUT: 'Check the international recipient, message length, template name, and language code.',
  WHATSAPP_CLI_INPUT: 'Check command options with --help. No message was sent.',
  WHATSAPP_CLI_PROMPT: 'Supply WHATSAPP_TEST_TO and, for text mode, WHATSAPP_TEST_TEXT, or run in an interactive terminal.',
};

function inputError() {
  return Object.assign(new Error('Invalid command options.'), { code: 'WHATSAPP_CLI_INPUT' });
}

function parseArguments(argv) {
  const options = { send: false };
  const valued = new Map([['--to', 'to'], ['--template', 'template'], ['--language', 'language'], ['--text', 'text'], ['--mode', 'mode']]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw inputError();
    seen.add(flag);
    if (flag === '--send') options.send = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (['--help', '-h'].includes(flag)) options.help = true;
    else if (valued.has(flag) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) {
      options[valued.get(flag)] = argv[++i];
    } else throw inputError();
  }
  if (options.send && options.dryRun) throw inputError();
  options.mode ||= options.text !== undefined ? 'text' : 'template';
  if (!['text', 'template'].includes(options.mode)
      || (options.mode === 'text' && (options.template !== undefined || options.language !== undefined))
      || (options.mode === 'template' && options.text !== undefined)) throw inputError();
  return options;
}

async function run(argv, {
  env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  prompt, createService = createWhatsAppService,
} = {}) {
  let attempted = false;
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout.write(JSON.stringify({ usage: USAGE }, null, 2) + '\n');
      return 0;
    }
    // Credentials are validated before asking the user for private message input.
    readWhatsAppSendConfig(env);
    async function ask(label) {
      if (prompt) return prompt(label);
      if (!stdin.isTTY) throw Object.assign(new Error('Interactive input unavailable.'), { code: 'WHATSAPP_CLI_PROMPT' });
      const terminal = readline.createInterface({ input: stdin, output: stdout });
      try { return await terminal.question(label); } finally { terminal.close(); }
    }
    const configuredTo = typeof env.WHATSAPP_TEST_TO === 'string' ? env.WHATSAPP_TEST_TO.trim() || undefined : undefined;
    const configuredText = typeof env.WHATSAPP_TEST_TEXT === 'string' && env.WHATSAPP_TEST_TEXT.trim() ? env.WHATSAPP_TEST_TEXT : undefined;
    const to = (options.to ?? configuredTo ?? await ask('Recipient with country code: ')).trim();
    const text = options.mode === 'text' ? (options.text ?? configuredText ?? await ask('Message text: ')) : undefined;
    const template = options.template ?? 'hello_world';
    const language = options.language ?? 'en_US';
    if (options.mode === 'text') validateTextMessage(to, text);
    else validateTemplateMessage(to, template, language);
    if (!options.send) {
      stdout.write(JSON.stringify({ status: 'DRY_RUN', deliveryState: 'NOT_ATTEMPTED', attempted: false,
        type: options.mode, recipient: maskPhone(to), message: 'Configuration and input valid. Add --send to make one Meta request.' }) + '\n');
      return 0;
    }
    const service = createService({ env, logger: { info() {}, error() {} } });
    attempted = true;
    if (options.mode === 'text') await service.sendTextMessage(to, text);
    else await service.sendTemplateMessage(to, template, language);
    stdout.write(JSON.stringify({ status: 'SENT', deliveryState: 'SENT', attempted: true,
      type: options.mode, recipient: maskPhone(to), message: 'Meta accepted the message. Handset delivery is not confirmed.' }) + '\n');
    return 0;
  } catch (error) {
    const deliveryState = ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN'].includes(error?.deliveryState)
      ? error.deliveryState : attempted ? 'UNKNOWN' : 'NOT_ATTEMPTED';
    const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'ERR_WHATSAPP_SEND';
    const details = {};
    for (const key of ['httpStatus', 'metaCode', 'metaSubcode']) {
      if (Number.isSafeInteger(error?.[key]) && error[key] >= 0
          && (key !== 'httpStatus' || (error[key] >= 100 && error[key] <= 599))) details[key] = error[key];
    }
    stderr.write(JSON.stringify({ status: 'FAILED', deliveryState, attempted: deliveryState !== 'NOT_ATTEMPTED', code,
      message: ERROR_MESSAGES[code] || (deliveryState === 'UNKNOWN'
        ? 'The send result is unknown. Check Meta before any manual resend.'
        : 'WhatsApp sending failed. Check local configuration and safe Meta error codes.'), ...details }) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const loaded = dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true, debug: false });
  if (loaded.error && loaded.error.code !== 'ENOENT') {
    process.stderr.write('Unable to read local environment configuration. No message was sent.\n');
    process.exitCode = 1;
  } else {
    run(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
      process.stderr.write('WhatsApp test command failed. Check the send result before retrying.\n');
      process.exitCode = 1;
    });
  }
}

module.exports = { run, parseArguments };
