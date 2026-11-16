/**
 * The types of the part of `@xmpp/client` 0.14 that `session.ts` uses. The package has no types of its own. Only
 * `session.ts` imports the package, so a move to another XMPP library changes one file and this one.
 */
declare module "@xmpp/client" {
  /** One XML element of the stream, an element of `ltx`. */
  export interface XmlElement {
    readonly name: string;
    readonly attrs: Readonly<Record<string, string | undefined>>;
    readonly children: readonly (XmlElement | string)[];
    is(name: string, xmlns?: string): boolean;
    getChild(name: string, xmlns?: string): XmlElement | undefined;
    getChildren(name: string, xmlns?: string): XmlElement[];
    getText(): string;
  }

  /** The reconnect part of the client. */
  export interface Reconnect {
    stop(): void;
  }

  /** The client of one XMPP connection. */
  export interface XmppClient {
    on(event: "online", listener: () => void): this;
    on(event: "offline", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "stanza", listener: (stanza: XmlElement) => void): this;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    send(element: XmlElement): Promise<void>;
    write(text: string): Promise<void>;
    isSecure(): boolean;
    readonly reconnect: Reconnect;
  }

  /** The options of a client. */
  export interface ClientOptions {
    readonly service: string;
    readonly domain: string;
    readonly resource: string;
    readonly username: string;
    readonly password: string;
    readonly timeout?: number;
  }

  export function client(options: ClientOptions): XmppClient;
  export function xml(name: string, attrs?: Readonly<Record<string, string>>, ...children: (XmlElement | string)[]): XmlElement;
}
