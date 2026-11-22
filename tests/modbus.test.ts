import { afterEach, describe, expect, it } from 'vitest';
import {
  ArrayRegisterMap,
  ModbusTcpClient,
  ModbusTcpSimServer,
  buildReadRequest,
  buildWriteMultipleRequest,
  buildWriteSingleRequest,
  parseResponse,
} from '../src/server/protocols/transports/modbus';

let server: ModbusTcpSimServer | null = null;
let client: ModbusTcpClient | null = null;

async function startServer(map = new ArrayRegisterMap(32)): Promise<{ port: number }> {
  server = await ModbusTcpSimServer.start({ map });
  return { port: server.address().port };
}

async function connectClient(port: number): Promise<ModbusTcpClient> {
  client = await ModbusTcpClient.connect('127.0.0.1', port);
  return client;
}

afterEach(async () => {
  client?.close();
  client = null;
  await server?.close();
  server = null;
});

describe('Modbus TCP 帧编解码', () => {
  it('读请求 MBAP + PDU 字段正确', () => {
    const frame = buildReadRequest(1, 1, 3, 10, 4);
    expect(frame.readUInt16BE(0)).toBe(1); // transactionId
    expect(frame.readUInt16BE(2)).toBe(0); // protocolId
    expect(frame.readUInt16BE(4)).toBe(6); // length
    expect(frame.readUInt8(6)).toBe(1); // unitId
    expect(frame.readUInt8(7)).toBe(3); // FC
    expect(frame.readUInt16BE(8)).toBe(10);
    expect(frame.readUInt16BE(10)).toBe(4);
  });

  it('写单 / 写多请求编码与响应解析往返', () => {
    const single = buildWriteSingleRequest(2, 1, 5, -1234);
    const parsedSingle = parseResponse(single.subarray(0, 0));
    expect(parsedSingle).toBeNull();

    const multi = buildWriteMultipleRequest(3, 1, 8, [10, 20, 30]);
    expect(multi.readUInt8(7)).toBe(16);
    expect(multi.readUInt16BE(8)).toBe(8);
    expect(multi.readUInt16BE(10)).toBe(3);
    expect(multi.readUInt8(12)).toBe(6);

    // 构造一个 FC3 响应帧走解析
    const resp = Buffer.alloc(13);
    resp.writeUInt16BE(9, 0);
    resp.writeUInt16BE(0, 2);
    resp.writeUInt16BE(7, 4);
    resp.writeUInt8(1, 6);
    resp.writeUInt8(3, 7);
    resp.writeUInt8(4, 8);
    resp.writeInt16BE(111, 9);
    resp.writeInt16BE(-222, 11);
    const parsed = parseResponse(resp);
    expect(parsed?.transactionId).toBe(9);
    expect(parsed?.registers).toEqual([111, -222]);
  });
});

describe('Modbus TCP 真实 socket 往返（127.0.0.1，用完即关）', () => {
  it('FC6 写单寄存器后 FC3 读回原值（含负数）', async () => {
    const { port } = await startServer();
    const sock = await connectClient(port);

    await sock.writeSingle(0, 1234);
    await sock.writeSingle(2, -1234);
    const regs = await sock.readHolding(0, 3);
    expect(regs).toEqual([1234, 0, -1234]);
  });

  it('FC16 写多寄存器后批量读回', async () => {
    const { port } = await startServer();
    const sock = await connectClient(port);

    await sock.writeMultiple(4, [100, 200, 300]);
    const regs = await sock.readHolding(4, 3);
    expect(regs).toEqual([100, 200, 300]);
  });

  it('FC4 读输入寄存器与 FC3 读保持寄存器共用同一内存表', async () => {
    const map = new ArrayRegisterMap(16);
    map.set(1, 555);
    const { port } = await startServer(map);
    const sock = await connectClient(port);

    const holding = await sock.readHolding(1, 1);
    const input = await sock.readInput(1, 1);
    expect(holding).toEqual([555]);
    expect(input).toEqual([555]);
  });

  it('越界地址返回异常码 02（非法数据地址）', async () => {
    const { port } = await startServer(new ArrayRegisterMap(8));
    const sock = await connectClient(port);

    await expect(sock.readHolding(7, 2)).rejects.toThrow(/异常码 2/);
  });

  it('服务器只允许监听 127.0.0.1', async () => {
    await expect(ModbusTcpSimServer.start({ host: '0.0.0.0' })).rejects.toThrow('127.0.0.1');
  });
});
