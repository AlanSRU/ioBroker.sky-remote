// Augments the globally declared ioBroker.AdapterConfig with this adapter's native config
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            host: string;
            port: number;
            connectionCheckFrequency: number;
        }
    }
}

// This must be an ES module so the global augmentation above applies
export {};
