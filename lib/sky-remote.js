'use strict';

/*
 * Sky Q / Sky+HD remote-control protocol.
 *
 * Vendored and modernized from the `sky-remote` package by Dal Hundal
 * (Unlicense / public domain): https://github.com/dalhundal/sky-remote
 *
 * Changes vs. the original: uses `node:net` and `Buffer.from()` (the legacy
 * `new Buffer()` constructor is deprecated), a Promise-based API, and a
 * socket-level idle timeout instead of a separate timer. The wire protocol
 * (handshake + key-down/key-up command bytes) is unchanged.
 */

const net = require('node:net');

const DEFAULT_PORT = 49160;
const DEFAULT_TIMEOUT_MS = 2000;

/** Map of button name -> Sky command code. */
const COMMANDS = {
    power: 0,
    select: 1,
    backup: 2,
    dismiss: 2,
    channelup: 6,
    channeldown: 7,
    interactive: 8,
    sidebar: 8,
    help: 9,
    services: 10,
    search: 10,
    tvguide: 11,
    home: 11,
    i: 14,
    text: 15,
    up: 16,
    down: 17,
    left: 18,
    right: 19,
    red: 32,
    green: 33,
    yellow: 34,
    blue: 35,
    0: 48,
    1: 49,
    2: 50,
    3: 51,
    4: 52,
    5: 53,
    6: 54,
    7: 55,
    8: 56,
    9: 57,
    play: 64,
    pause: 65,
    stop: 66,
    record: 67,
    fastforward: 69,
    rewind: 71,
    boxoffice: 240,
    sky: 241,
};

/**
 * Send a single remote-control command to a Sky box.
 *
 * @param {string} host Sky box IP address or hostname
 * @param {number} [port] TCP port (default 49160)
 * @param {string} command button name (see {@link COMMANDS})
 * @param {number} [timeoutMs] idle/connect timeout in ms (default 2000)
 * @returns {Promise<void>} resolves once the command has been sent
 */
function sendCommand(host, port, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const code = COMMANDS[command];
        if (code === undefined) {
            reject(new Error(`Unknown Sky command: "${command}"`));
            return;
        }

        // Byte 1 toggles key-down (1) / key-up (0).
        const commandBytes = [4, 1, 0, 0, 0, 0, Math.floor(224 + code / 16), code % 16];

        const socket = net.connect({ host, port: port || DEFAULT_PORT });
        let settled = false;
        let echoLength = 12;

        const finish = err => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        // Idle timeout guards both the initial connect and a stalled handshake.
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => {
            const err = new Error(`Sky command timeout ${host}:${port || DEFAULT_PORT}`);
            err.name = 'ECONNTIMEOUT';
            finish(err);
        });
        socket.on('error', finish);
        socket.on('data', data => {
            // The box sends a short handshake; echo part of it back, then send
            // the command twice (key down, then key up).
            if (data.length < 24) {
                socket.write(data.subarray(0, echoLength));
                echoLength = 1;
            } else {
                socket.write(Buffer.from(commandBytes), () => {
                    commandBytes[1] = 0;
                    socket.write(Buffer.from(commandBytes), () => finish(null));
                });
            }
        });
    });
}

module.exports = { sendCommand, COMMANDS, DEFAULT_PORT };
