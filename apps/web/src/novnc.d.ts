declare module "@novnc/novnc/lib/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    disconnect(): void;
  }
}
