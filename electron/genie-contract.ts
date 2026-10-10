import type { GenieGeometry } from './genie-geometry';

export interface GeniePayload extends GenieGeometry {
    generation: number;
    direction: 'out' | 'in';
    image: string;
}

export interface GenieBridge {
    payload(): Promise<GeniePayload | null>;
    ready(): Promise<boolean>;
    done(): Promise<void>;
}
