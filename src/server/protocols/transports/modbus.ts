/**
 * WP8 工业接口：Modbus TCP 帧编解码 + 进程内真实 socket 模拟服务器。
 *
 * 实现口径：
 * - 功能码 03（读保持寄存器）、04（读输入寄存器）、06（写单寄存器）、
 *   16（写多寄存器）；异常码 01 非法功能 / 02 非法地址 / 03 非法值；
 * - 服务器用 `node:net` 真实监听 **127.0.0.1** 随机端口，客户端走真实
 *   TCP 往返；测试用完即关，不长期占用端口；
 * - 寄存器为 16 位有符号整数，工程量程缩放由标签表（tags.ts）负责，
 *   本层只搬运原始整数。
 *
 * 边界：未做 Modbus RTU 串行链路、未做 TLS 网关、未接真实 PLC；
 * 现场点表与网络分区属于现场验收门。
 */
import net from 'node:net';
import { MODBUS_HOLDING_BASE, TAG_DEFINITIONS } from '../tags';

export const FC_READ_HOLDING = 3;
export const FC_READ_INPUT = 4;
export const FC_WRITE_SINGLE = 6;
export const FC_WRITE_MULTIPLE = 16;

export const EX_ILLEGAL_FUNCTION = 0x01;
export const EX_ILLEGAL_ADDRESS = 0x02;
export const EX_ILLEGAL_VALUE = 0x03;

const PROTOCOL_ID = 0;
const DEFAULT_UNIT_ID = 1;
const LOOPBACK = '127.0.0.1';

export interface ModbusRegisterMap {
  get(address: number): number;
  set(address: number, value: number): void;
  size(): number;
}

/** 内存寄存器表；地址为 0 基偏移（40001 → 0） */
export class ArrayRegisterMap implements ModbusRegisterMap {
  private readonly regs: number[];

  constructor(size: number) {
    this.regs = new Array(size).fill(0);
  }

  get(address: number): number {
    this.assertAddress(address, 1);
    return this.regs[address];
  }

  set(address: number, value: number): void {
    this.assertAddress(address, 1);
    if (!Number.isInteger(value) || value < -32768 || value > 32767) {
      throw new Error(`寄存器值越界：${value}`);
    }
    this.regs[address] = value;
  }

  size(): number {
    return this.regs.length;
  }

  private assertAddress(address: number, quantity: number): void {
    if (address < 0 || address + quantity > this.regs.length) {
      throw new Error(`非法寄存器地址：${address}（数量 ${quantity}）`);
    }
  }
}

// ---- 帧编解码 ----

function writeMbap(buffer: Buffer, offset: number, tid: number, unitId: number, pduLength: number): void {
  buffer.writeUInt16BE(tid, offset);
  buffer.writeUInt16BE(PROTOCOL_ID, offset + 2);
  buffer.writeUInt16BE(pduLength + 1, offset + 4); // length = unitId + PDU
  buffer.writeUInt8(unitId, offset + 6);
}

/** 03/04 读请求 */
export function buildReadRequest(tid: number, unitId: number, fc: number, address: number, quantity: number): Buffer {
  const frame = Buffer.alloc(12);
  writeMbap(frame, 0, tid, unitId, 5);
  frame.writeUInt8(fc, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(quantity, 10);
  return frame;
}

/** 06 写单寄存器请求 */
export function buildWriteSingleRequest(tid: number, unitId: number, address: number, value: number): Buffer {
  const frame = Buffer.alloc(12);
  writeMbap(frame, 0, tid, unitId, 5);
  frame.writeUInt8(FC_WRITE_SINGLE, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeInt16BE(value, 10);
  return frame;
}

/** 16 写多寄存器请求 */
export function buildWriteMultipleRequest(tid: number, unitId: number, address: number, values: number[]): Buffer {
  const pduLength = 6 + values.length * 2;
  const frame = Buffer.alloc(7 + pduLength);
  writeMbap(frame, 0, tid, unitId, pduLength);
  frame.writeUInt8(FC_WRITE_MULTIPLE, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(values.length, 10);
  frame.writeUInt8(values.length * 2, 12);
  values.forEach((v, i) => frame.writeInt16BE(v, 13 + i * 2));
  return frame;
}

export interface ModbusResponse {
  transactionId: number;
  functionCode: number;
  registers: number[];
  exception?: number;
}

/** 解析一帧完整 MBAP 响应；帧不完整返回 null */
export function parseResponse(frame: Buffer): ModbusResponse | null {
  if (frame.length < 8) return null;
  const tid = frame.readUInt16BE(0);
  const protocolId = frame.readUInt16BE(2);
  const length = frame.readUInt16BE(4);
  if (protocolId !== PROTOCOL_ID) throw new Error('Modbus 协议标识非法');
  if (frame.length < 6 + length) return null;
  const pdu = frame.subarray(7, 6 + length);
  const fc = pdu[0];

  if ((fc & 0x80) !== 0) {
    return { transactionId: tid, functionCode: fc & 0x7f, registers: [], exception: pdu[1] };
  }

  const registers: number[] = [];
  if (fc === FC_READ_HOLDING || fc === FC_READ_INPUT) {
    const byteCount = pdu[1];
    const count = byteCount / 2;
    for (let i = 0; i < count; i += 1) registers.push(pdu.readInt16BE(2 + i * 2));
  } else if (fc === FC_WRITE_SINGLE) {
    registers.push(pdu.readInt16BE(3));
  }
  // FC16 响应只回显地址与数量，不带寄存器值，registers 保持空数组
  return { transactionId: tid, functionCode: fc, registers };
}

// ---- 模拟服务器 ----

export interface ModbusServerOptions {
  host?: string;
  port?: number;
  map?: ModbusRegisterMap;
  /** 写操作回调（审计挂钩），地址为 0 基偏移 */
  onWrite?: (address: number, value: number, fc: number) => void;
}

export class ModbusTcpSimServer {
  private readonly map: ModbusRegisterMap;
  private readonly onWrite?: (address: number, value: number, fc: number) => void;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  private constructor(map: ModbusRegisterMap, onWrite?: ModbusServerOptions['onWrite']) {
    this.map = map;
    this.onWrite = onWrite;
  }

  static async start(options: ModbusServerOptions = {}): Promise<ModbusTcpSimServer> {
    const host = options.host ?? LOOPBACK;
    if (host !== LOOPBACK) {
      throw new Error('WP8 模拟 Modbus 服务器只允许监听 127.0.0.1');
    }
    const server = new ModbusTcpSimServer(options.map ?? new ArrayRegisterMap(64), options.onWrite);
    await new Promise<void>((resolve, reject) => {
      const netServer = net.createServer((sock) => server.attach(sock));
      netServer.on('error', reject);
      netServer.listen(options.port ?? 0, host, () => {
        server.server = netServer;
        resolve();
      });
    });
    return server;
  }

  address(): { host: string; port: number } {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string') throw new Error('服务器未监听');
    return { host: LOOPBACK, port: addr.port };
  }

  private attach(sock: net.Socket): void {
    this.sockets.add(sock);
    let buffer = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      for (;;) {
        if (buffer.length < 6) break;
        const length = buffer.readUInt16BE(4);
        const frameLen = 6 + length;
        if (buffer.length < frameLen) break;
        const frame = buffer.subarray(0, frameLen);
        buffer = buffer.subarray(frameLen);
        sock.write(this.dispatch(frame));
      }
    });
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => this.sockets.delete(sock));
  }

  private dispatch(frame: Buffer): Buffer {
    const tid = frame.readUInt16BE(0);
    const unitId = frame.readUInt8(6);
    const pdu = frame.subarray(7);
    const fc = pdu[0];

    const exception = (code: number): Buffer => {
      const out = Buffer.alloc(9);
      writeMbap(out, 0, tid, unitId, 2);
      out.writeUInt8(fc | 0x80, 7);
      out.writeUInt8(code, 8);
      return out;
    };

    if (fc === FC_READ_HOLDING || fc === FC_READ_INPUT) {
      const address = pdu.readUInt16BE(1);
      const quantity = pdu.readUInt16BE(3);
      if (quantity < 1 || quantity > 125) return exception(EX_ILLEGAL_VALUE);
      if (address + quantity > this.map.size()) return exception(EX_ILLEGAL_ADDRESS);
      const out = Buffer.alloc(9 + quantity * 2);
      writeMbap(out, 0, tid, unitId, 2 + quantity * 2);
      out.writeUInt8(fc, 7);
      out.writeUInt8(quantity * 2, 8);
      for (let i = 0; i < quantity; i += 1) out.writeInt16BE(this.map.get(address + i), 9 + i * 2);
      return out;
    }

    if (fc === FC_WRITE_SINGLE) {
      const address = pdu.readUInt16BE(1);
      const value = pdu.readInt16BE(3);
      if (address >= this.map.size()) return exception(EX_ILLEGAL_ADDRESS);
      try {
        this.map.set(address, value);
      } catch {
        return exception(EX_ILLEGAL_VALUE);
      }
      this.onWrite?.(address, value, fc);
      const out = Buffer.alloc(12);
      writeMbap(out, 0, tid, unitId, 5);
      out.writeUInt8(fc, 7);
      out.writeUInt16BE(address, 8);
      out.writeInt16BE(value, 10);
      return out;
    }

    if (fc === FC_WRITE_MULTIPLE) {
      const address = pdu.readUInt16BE(1);
      const quantity = pdu.readUInt16BE(3);
      const byteCount = pdu[5];
      if (quantity < 1 || quantity > 123 || byteCount !== quantity * 2) return exception(EX_ILLEGAL_VALUE);
      if (address + quantity > this.map.size()) return exception(EX_ILLEGAL_ADDRESS);
      for (let i = 0; i < quantity; i += 1) {
        const value = pdu.readInt16BE(6 + i * 2);
        this.map.set(address + i, value);
        this.onWrite?.(address + i, value, fc);
      }
      const out = Buffer.alloc(12);
      writeMbap(out, 0, tid, unitId, 5);
      out.writeUInt8(fc, 7);
      out.writeUInt16BE(address, 8);
      out.writeUInt16BE(quantity, 10);
      return out;
    }

    return exception(EX_ILLEGAL_FUNCTION);
  }

  close(): Promise<void> {
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}

// ---- 客户端 ----

interface PendingRequest {
  resolve: (registers: number[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export class ModbusTcpClient {
  private socket: net.Socket | null = null;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private tid = 0;
  private readonly timeoutMs: number;

  private constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  static async connect(host: string, port: number, timeoutMs = 3_000): Promise<ModbusTcpClient> {
    const client = new ModbusTcpClient(timeoutMs);
    const socket = new net.Socket();
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 ${host}:${port} 超时`));
      }, timeoutMs);
      socket.once('error', reject);
      socket.connect(port, host, () => {
        globalThis.clearTimeout(timer);
        socket.off('error', reject);
        resolve();
      });
    });
    client.socket = socket;
    socket.on('data', (chunk) => client.onData(chunk));
    socket.on('error', (err) => client.failPending(err));
    socket.on('close', () => client.failPending(new Error('Modbus 连接已关闭')));
    return client;
  }

  readHolding(address: number, quantity: number): Promise<number[]> {
    return this.request(buildReadRequest(this.nextTid(), DEFAULT_UNIT_ID, FC_READ_HOLDING, address, quantity));
  }

  readInput(address: number, quantity: number): Promise<number[]> {
    return this.request(buildReadRequest(this.nextTid(), DEFAULT_UNIT_ID, FC_READ_INPUT, address, quantity));
  }

  writeSingle(address: number, value: number): Promise<number[]> {
    return this.request(buildWriteSingleRequest(this.nextTid(), DEFAULT_UNIT_ID, address, value));
  }

  writeMultiple(address: number, values: number[]): Promise<number[]> {
    return this.request(buildWriteMultipleRequest(this.nextTid(), DEFAULT_UNIT_ID, address, values));
  }

  close(): void {
    this.failPending(new Error('客户端主动关闭'));
    this.socket?.destroy();
    this.socket = null;
  }

  private nextTid(): number {
    this.tid = (this.tid + 1) & 0xffff;
    return this.tid;
  }

  private request(frame: Buffer): Promise<number[]> {
    if (!this.socket) return Promise.reject(new Error('Modbus 客户端未连接'));
    const tid = frame.readUInt16BE(0);
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error(`Modbus 请求超时（tid=${tid}）`));
      }, this.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer });
      this.socket?.write(frame);
    });
  }

  private onData(chunk: Buffer | string | NonSharedBuffer): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    for (;;) {
      if (this.buffer.length < 6) break;
      const length = this.buffer.readUInt16BE(4);
      const frameLen = 6 + length;
      if (this.buffer.length < frameLen) break;
      const frame = this.buffer.subarray(0, frameLen);
      this.buffer = this.buffer.subarray(frameLen);
      const parsed = parseResponse(frame);
      if (!parsed) continue;
      const pending = this.pending.get(parsed.transactionId);
      if (!pending) continue;
      this.pending.delete(parsed.transactionId);
      globalThis.clearTimeout(pending.timer);
      if (parsed.exception !== undefined) {
        pending.reject(new Error(`Modbus 异常码 ${parsed.exception}（FC ${parsed.functionCode}）`));
      } else {
        pending.resolve(parsed.registers);
      }
    }
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/** 标签表覆盖的寄存器数量（偏移 0 基，供初始化寄存器表尺寸） */
export function modbusRegisterCount(): number {
  const maxRegister = Math.max(...TAG_DEFINITIONS.map((t) => t.address.modbusRegister));
  return maxRegister - MODBUS_HOLDING_BASE + 1;
}
