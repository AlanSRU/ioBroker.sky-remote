'use strict';

const utils = require('@iobroker/adapter-core');
const SkyRemote = require('sky-remote');

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

        this.remoteControl = null;
        this.isConnected = false;
        this.connectionCheckInterval = null;

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

        // Get config values
        this.host = this.config.host || '';
        this.port = this.config.port || 49160;
        this.connectionCheckFrequency = this.config.connectionCheckFrequency || 60000;

        // Check if host is configured
        if (!this.host) {
            this.log.error('No Sky box IP address configured');
            this.setState('info.connection', false, true);
            return;
        }

        // Initialize Sky Remote
        try {
            this.remoteControl = new SkyRemote(this.host, this.port);
            this.log.info(`Sky Remote initialized for ${this.host}:${this.port}`);
        } catch (err) {
            this.log.error(`Failed to initialize Sky Remote: ${err.message}`);
            this.setState('info.connection', false, true);
            return;
        }

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
            await this.setObjectNotExistsAsync(`buttons.${button}`, {
                type: 'state',
                common: {
                    name: `Sky ${button}`,
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });

            // Initialize to false with ack
            await this.setState(`buttons.${button}`, false, true);
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
                desc: 'Send a sequence of commands separated by comma (e.g. "home,right,select")',
            },
            native: {},
        });
    }

    /**
     * Check connection to Sky box using TCP connection only
     * This doesn't send a command to avoid triggering on-screen display
     */
    checkConnection() {
        if (!this.host || !this.port) {
            this.setState('info.connection', false, true);
            return;
        }

        // Use direct TCP socket connection to check if port is open
        const net = require('node:net');
        const socket = new net.Socket();

        // Set timeout to avoid hanging
        socket.setTimeout(2000);

        // Connection successful
        socket.on('connect', () => {
            this.log.debug(`TCP connection to ${this.host}:${this.port} successful`);

            // Only update if changed
            if (!this.isConnected) {
                this.isConnected = true;
                this.setState('info.connection', true, true);
                this.log.info(`Connection status changed to: connected`);
            }

            // Close the socket properly
            socket.end();
            socket.destroy();
        });

        // Connection error
        socket.on('error', err => {
            this.log.debug(`TCP connection failed: ${err.message}`);

            // Only update if changed
            if (this.isConnected) {
                this.isConnected = false;
                this.setState('info.connection', false, true);
                this.log.info(`Connection status changed to: disconnected`);
            }

            // Ensure socket is destroyed
            socket.destroy();
        });

        // Handle timeout
        socket.on('timeout', () => {
            this.log.debug(`TCP connection timed out`);

            // Only update if changed
            if (this.isConnected) {
                this.isConnected = false;
                this.setState('info.connection', false, true);
                this.log.info(`Connection status changed to: disconnected (timeout)`);
            }

            // Ensure socket is destroyed
            socket.destroy();
        });

        // Attempt connection
        this.log.debug(`Checking TCP connection to ${this.host}:${this.port}`);
        socket.connect(this.port, this.host);
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

        // Extract command from ID
        const idParts = id.split('.');
        const command = idParts[idParts.length - 1];
        const stateType = idParts[idParts.length - 2];

        // Handle button press
        if (stateType === 'buttons' && state.val === true) {
            this.log.info(`Button press: ${command}`);

            if (!this.remoteControl) {
                this.log.error('Sky remote not initialized');
                this.setForeignState(id, false, true);
                return;
            }

            // Send command to Sky box
            this.remoteControl.press(command, err => {
                if (err) {
                    this.log.error(`Error sending command: ${err.message}`);
                    this.setState('info.connection', false, true);
                } else {
                    this.log.debug(`Command sent successfully: ${command}`);
                    this.setState('info.connection', true, true);
                }

                // Reset button state with ack after a short delay
                this.setTimeout(() => {
                    this.log.info(`Resetting button state: ${id}`);
                    this.setForeignState(id, false, true);
                }, 200);
            });
        } else if (id.endsWith('sendSequence') && typeof state.val === 'string' && state.val) {
            // Handle sequence
            // Parse sequence into array of commands
            const sequence = state.val.split(',').map(cmd => cmd.trim());

            if (sequence.length === 0) {
                return;
            }

            this.log.info(`Sending sequence: ${sequence.join(', ')}`);

            if (!this.remoteControl) {
                this.log.error('Sky remote not initialized');
                return;
            }

            // Send command sequence
            this.remoteControl.press(sequence, err => {
                if (err) {
                    this.log.error(`Error sending sequence: ${err.message}`);
                    this.setState('info.connection', false, true);
                } else {
                    this.log.debug('Sequence sent successfully');
                    this.setState('info.connection', true, true);
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
            // Clear connection check interval
            if (this.connectionCheckInterval) {
                this.clearInterval(this.connectionCheckInterval);
                this.connectionCheckInterval = null;
            }

            // Clean up
            this.remoteControl = null;
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
