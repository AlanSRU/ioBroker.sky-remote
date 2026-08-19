'use strict';

const utils = require('@iobroker/adapter-core');
const skyRemote = require('./lib/sky-remote');

// Delay between commands in a sequence so the Sky box registers each key press.
const SEQUENCE_DELAY_MS = 500;

// Human-friendly labels for the button states (falls back to the raw command name).
const BUTTON_LABELS = {
    power: 'Power',
    tvguide: 'TV Guide',
    boxoffice: 'Box Office',
    services: 'Services',
    interactive: 'Interactive',
    help: 'Help',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    select: 'Select / OK',
    backup: 'Back',
    text: 'Text',
    i: 'Info',
    red: 'Red',
    green: 'Green',
    yellow: 'Yellow',
    blue: 'Blue',
    play: 'Play',
    pause: 'Pause',
    stop: 'Stop',
    rewind: 'Rewind',
    fastforward: 'Fast Forward',
    record: 'Record',
    channelup: 'Channel Up',
    channeldown: 'Channel Down',
    home: 'Home',
    sky: 'Sky',
};

class SkyRemoteAdapter extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({
            ...options,
            name: 'sky-remote',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.isConnected = null;
        this.connectionCheckInterval = null;
        this.checkSocket = null;
        this.unloaded = false;

        // All supported Sky Remote button commands
        this.buttons = [
            'power',
            'tvguide',
            'boxoffice',
            'services',
            'interactive',
            'help',
            'up',
            'down',
            'left',
            'right',
            'select',
            'backup',
            'text',
            'i',
            'red',
            'green',
            'yellow',
            'blue',
            '0',
            '1',
            '2',
            '3',
            '4',
            '5',
            '6',
            '7',
            '8',
            '9',
            'play',
            'pause',
            'stop',
            'rewind',
            'fastforward',
            'record',
            'channelup',
            'channeldown',
            'home',
            'sky',
        ];
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.info('Starting adapter...');

        // Get config values (validate/clamp — the admin UI limits are not enforced
        // for values set via CLI or by editing the config directly)
        // Deliberately not this.host — the Adapter base class owns that (the ioBroker host name)
        this.skyHost = this.config.host || '';
        const port = parseInt(this.config.port, 10);
        this.port = port >= 1 && port <= 65535 ? port : 49160;
        const freq = parseInt(this.config.connectionCheckFrequency, 10) || 60000;
        this.connectionCheckFrequency = Math.min(300000, Math.max(5000, freq));

        // Check if host is configured
        if (!this.skyHost) {
            this.log.error('No Sky box IP address configured');
            this.setConnected(false);
            return;
        }

        this.log.info(`Sky Remote target set to ${this.skyHost}:${this.port}`);

        // Create button states
        await this.createButtonStates();

        // IMPORTANT: Subscribe to states
        this.log.info('Subscribing to button states');
        await this.subscribeStatesAsync('buttons.*');
        await this.subscribeStatesAsync('sendSequence');

        // Set up connection check
        this.checkConnection();
        this.connectionCheckInterval = this.setInterval(() => {
            this.checkConnection();
        }, this.connectionCheckFrequency);

        this.log.info('Adapter started successfully');
    }

    /**
     * Create states for all buttons
     */
    async createButtonStates() {
        // Create buttons channel if it doesn't exist
        await this.setObjectNotExistsAsync('buttons', {
            type: 'channel',
            common: {
                name: 'Remote Buttons',
            },
            native: {},
        });

        // Create each button state
        for (const button of this.buttons) {
            // extendObject (not setObjectNotExists) so existing installations get the
            // corrected read flag on upgrade
            await this.extendObjectAsync(`buttons.${button}`, {
                type: 'state',
                common: {
                    name: `Sky ${BUTTON_LABELS[button] || button}`,
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            });
        }

        // Create sequence state
        await this.setObjectNotExistsAsync('sendSequence', {
            type: 'state',
            common: {
                name: 'Send Command Sequence',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                def: '',
                desc: 'Send a sequence of commands separated by comma (e.g. "home,right,select")',
            },
            native: {},
        });
    }

    /**
     * Update info.connection, keeping the cached flag and the state in step.
     * Every writer must go through here — a direct setState would desync the cache
     * and latch the state at a stale value.
     *
     * @param {boolean} connected
     */
    setConnected(connected) {
        if (this.unloaded || this.isConnected === connected) {
            return;
        }

        this.isConnected = connected;
        this.setState('info.connection', connected, true);
        this.log.info(`Connection status changed to: ${connected ? 'connected' : 'disconnected'}`);
    }

    /**
     * Check connection to Sky box using TCP connection only
     * This doesn't send a command to avoid triggering on-screen display
     */
    checkConnection() {
        if (!this.skyHost || !this.port) {
            this.setConnected(false);
            return;
        }

        // Use direct TCP socket connection to check if port is open
        const net = require('node:net');
        const socket = new net.Socket();
        this.checkSocket = socket;

        // Set timeout to avoid hanging
        socket.setTimeout(2000);

        // Connection successful
        socket.on('connect', () => {
            this.log.debug(`TCP connection to ${this.skyHost}:${this.port} successful`);

            this.setConnected(true);

            // Close the socket properly
            socket.end();
            socket.destroy();
        });

        // Connection error
        socket.on('error', err => {
            this.log.debug(`TCP connection failed: ${err.message}`);

            this.setConnected(false);

            // Ensure socket is destroyed
            socket.destroy();
        });

        // Handle timeout
        socket.on('timeout', () => {
            this.log.debug(`TCP connection timed out`);

            this.setConnected(false);

            // Ensure socket is destroyed
            socket.destroy();
        });

        // Attempt connection
        this.log.debug(`Checking TCP connection to ${this.skyHost}:${this.port}`);
        socket.connect(this.port, this.skyHost);
    }

    /**
     * Send one or more remote commands to the Sky box, spaced out so the box
     * registers each key press.
     *
     * @param {string | string[]} sequence single command, comma-separated string, or array of commands
     * @returns {Promise<void>}
     */
    async press(sequence) {
        const commands = (Array.isArray(sequence) ? sequence : String(sequence).split(','))
            .map(cmd => cmd.trim())
            .filter(cmd => cmd.length);

        for (let i = 0; i < commands.length; i++) {
            await skyRemote.sendCommand(this.skyHost, this.port, commands[i]);
            // brief gap between commands in a sequence
            if (i < commands.length - 1) {
                await this.delay(SEQUENCE_DELAY_MS);
            }
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        // Skip if null or acknowledged
        if (!state || state.ack) {
            return;
        }

        this.log.info(`State change: ${id} = ${state.val} (ack: ${state.ack})`);

        if (!this.skyHost) {
            this.log.error('No Sky box IP address configured');
            return;
        }

        // Extract command from ID
        const idParts = id.split('.');
        const command = idParts[idParts.length - 1];
        const stateType = idParts[idParts.length - 2];

        // Handle button press
        if (stateType === 'buttons' && state.val === true) {
            this.log.info(`Button press: ${command}`);

            this.press(command)
                .then(() => {
                    this.log.debug(`Command sent successfully: ${command}`);
                    this.setConnected(true);
                })
                .catch(err => {
                    this.log.error(`Error sending command: ${err.message}`);
                    if (err.name !== 'EUNKNOWNCOMMAND') {
                        this.setConnected(false);
                    }
                });
        } else if (id.endsWith('sendSequence') && typeof state.val === 'string' && state.val) {
            // Handle sequence
            this.log.info(`Sending sequence: ${state.val}`);

            this.press(state.val)
                .then(() => {
                    this.log.debug('Sequence sent successfully');
                    this.setConnected(true);
                })
                .catch(err => {
                    this.log.error(`Error sending sequence: ${err.message}`);
                    if (err.name !== 'EUNKNOWNCOMMAND') {
                        this.setConnected(false);
                    }
                });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Set first: stops any in-flight socket callback writing state after teardown
            this.unloaded = true;

            // Clear connection check interval
            if (this.connectionCheckInterval) {
                this.clearInterval(this.connectionCheckInterval);
                this.connectionCheckInterval = null;
            }

            // Drop an in-flight connection check
            if (this.checkSocket) {
                this.checkSocket.destroy();
                this.checkSocket = null;
            }

            this.log.info('Sky Remote adapter stopped');

            callback();
        } catch (e) {
            this.log.error(`Error during shutdown: ${e}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new SkyRemoteAdapter(options);
} else {
    // otherwise start the instance directly
    new SkyRemoteAdapter();
}
