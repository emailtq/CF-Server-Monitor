export const TERMINAL_LIMITS = Object.freeze({
  protocol: 1, maxSessions: 4, dataFrameBytes: 16384,
  controlFrameBytes: 4096, creditBytes: 262144,
  maxDimension: 500, startTimeoutMs: 30000, ackTimeoutMs: 30000,
  userIdleMs: 1800000, authLeaseMs: 60000, disableTimeoutMs: 5000
});

export function validateTerminalSize(cols, rows) {
  return [cols, rows].every(value =>
    Number.isInteger(value) && value >= 1 && value <= TERMINAL_LIMITS.maxDimension);
}

export function validateTerminalDataFrame(data) {
  return (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) &&
    data.byteLength <= TERMINAL_LIMITS.dataFrameBytes;
}

// Roles name the sender, not the receiving socket.
const ROLE_TYPES = {
  'agent-control': ['hello', 'disabled', 'ping', 'pong'],
  'broker-control': ['open', 'close', 'bound', 'disable', 'ping', 'pong'],
  browser: ['resize', 'ack', 'ping', 'pong'],
  agent: ['ready', 'ack', 'exit', 'error', 'ping', 'pong'],
  broker: ['start', 'ready', 'resize', 'ack', 'exit', 'error', 'ping', 'pong']
};
const CONTROL_FIELDS = {
  hello: ['type', 'protocol', 'platform', 'capabilities'],
  open: ['type', 'protocol', 'sessionId', 'ticket', 'cols', 'rows'],
  close: ['type', 'sessionId', 'reason'],
  bound: ['type', 'serverId', 'connectionId', 'generation', 'credentialVersion'],
  disable: ['type', 'operationId', 'serverId', 'connectionId', 'generation', 'credentialVersion'],
  disabled: ['type', 'operationId', 'serverId', 'connectionId', 'generation', 'credentialVersion'],
  start: ['type', 'cols', 'rows'],
  resize: ['type', 'cols', 'rows'],
  ack: ['type', 'bytes'],
  exit: ['type', 'code'],
  error: ['type', 'code'],
  ready: ['type'],
  ping: ['type'],
  pong: ['type']
};
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);

export function parseTerminalControl(text, role) {
  if (typeof text !== 'string' || text.length > TERMINAL_LIMITS.controlFrameBytes ||
      new TextEncoder().encode(text).byteLength > TERMINAL_LIMITS.controlFrameBytes) {
    throw new RangeError('Invalid terminal control size');
  }
  let frame;
  try {
    frame = JSON.parse(text);
  } catch (_) {
    throw new RangeError('Invalid terminal control JSON');
  }
  if (!frame || Array.isArray(frame) || typeof frame !== 'object' ||
      !Object.hasOwn(ROLE_TYPES, role) || !ROLE_TYPES[role].includes(frame.type)) {
    throw new RangeError('Invalid terminal control role or type');
  }
  const fields = CONTROL_FIELDS[frame.type];
  if (Object.keys(frame).length !== fields.length || fields.some(field => !Object.hasOwn(frame, field))) {
    throw new RangeError('Invalid terminal control fields');
  }
  let valid = true;
  switch (frame.type) {
    case 'hello':
      valid = frame.protocol === TERMINAL_LIMITS.protocol && frame.platform === 'linux' &&
        Array.isArray(frame.capabilities) && [1, 2].includes(frame.capabilities.length) &&
        frame.capabilities[0] === 'terminal.pty.v1' &&
        (frame.capabilities.length === 1 || frame.capabilities[1] === 'terminal.disable.v1');
      break;
    case 'bound':
    case 'disable':
    case 'disabled':
      valid = isId(frame.serverId) && isId(frame.connectionId) &&
        Number.isSafeInteger(frame.generation) && frame.generation >= 1 &&
        Number.isSafeInteger(frame.credentialVersion) && frame.credentialVersion >= 1 &&
        (frame.type === 'bound' || isId(frame.operationId));
      break;
    case 'open':
      valid = frame.protocol === TERMINAL_LIMITS.protocol && isId(frame.sessionId) &&
        typeof frame.ticket === 'string' && /^[a-f0-9]{64}$/.test(frame.ticket) &&
        validateTerminalSize(frame.cols, frame.rows);
      break;
    case 'close':
      valid = isId(frame.sessionId) && isCode(frame.reason);
      break;
    case 'start':
    case 'resize':
      valid = validateTerminalSize(frame.cols, frame.rows);
      break;
    case 'ack':
      // Cumulative byte counters; monotonicity and forwarded-byte bounds require session state.
      valid = Number.isSafeInteger(frame.bytes) && frame.bytes >= 0;
      break;
    case 'exit':
      valid = Number.isInteger(frame.code) && frame.code >= -1 && frame.code <= 255;
      break;
    case 'error':
      valid = isCode(frame.code);
      break;
  }
  if (!valid) throw new RangeError('Invalid terminal control values');
  return frame;
}
