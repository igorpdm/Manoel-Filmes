const CACHE_TTL = 15 * 60 * 1000;

export class TTLCache<K, V> extends Map<K, V> {
    private timestamps = new Map<K, number>();
    private cleanupInterval: NodeJS.Timeout | null = null;

    constructor() {
        super();
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    set(key: K, value: V): this {
        this.timestamps.set(key, Date.now());
        return super.set(key, value);
    }

    get(key: K): V | undefined {
        const value = super.get(key);
        if (value !== undefined) {
            this.timestamps.set(key, Date.now());
        }
        return value;
    }

    delete(key: K): boolean {
        this.timestamps.delete(key);
        return super.delete(key);
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [key, timestamp] of this.timestamps) {
            if (now - timestamp > CACHE_TTL) {
                this.delete(key);
            }
        }
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clear();
        this.timestamps.clear();
    }
}
