import { EventEmitter } from "events";
import { helper, plugins, messaging, Protocol, Conversation } from "node-purple";
import { PurpleAccount } from "./PurpleAccount";
import { IPurpleInstance, IConfigArgs } from "./IPurpleInstance";
import { Logging } from "matrix-appservice-bridge";
import * as path from "path";
const log = Logging.get("PurpleInstance");

const EXPECTED_PURPLE_PLUGINS_DIR =  "./node_modules/node-purple/deps/libpurple/";

export class PurpleProtocol {
    public readonly name: string;
    public readonly summary: string;
    public readonly homepage: string;
    public readonly id: string;
    constructor(data: Protocol) {
        this.name = data.name;
        this.summary = data.summary!;
        this.homepage = data.homepage!;
        this.id = data.id;
    }
}

export class PurpleInstance extends EventEmitter implements IPurpleInstance {
    private protocols: PurpleProtocol[];
    private accounts: Map<string, PurpleAccount>;
    private interval?: NodeJS.Timeout;
    constructor() {
        super();
        this.protocols = [];
        this.accounts = new Map();
    }

    public async start(config: IConfigArgs) {
        log.info("Starting purple instance");
        const pluginDir = path.resolve(config.pluginDir || EXPECTED_PURPLE_PLUGINS_DIR);
        log.info("Plugin search path is set to ", pluginDir);
        helper.setupPurple({
            debugEnabled: config.enableDebug ? 1 : 0,
            pluginDir,
            userDir: undefined,
        });
        log.info("Started purple instance");
        this.protocols = plugins.get_protocols().map(
            (data) => new PurpleProtocol(data),
        );
        log.info("Got supported protocols:", this.protocols.map((p) => p.id).join(" "));
        this.interval = setInterval(this.eventHandler.bind(this), 300);
    }

    public getAccount(username: string, protocolId: string): PurpleAccount|null {
        const key = `${protocolId}://${username}`;
        let acct = this.accounts.get(key);
        if (!acct) {
            const protocol = this.getProtocol(protocolId);
            if (protocol === undefined) {
                throw new Error("Protocol not found");
            }
            acct = new PurpleAccount(username, protocol);
            try {
                acct.findAccount();
            } catch (ex) {
                return null;
            }
            this.accounts.set(key, acct);
        }
        return acct;
    }

    public getProtocol(id: string) {
        return this.protocols.find((proto) => proto.id === id);
    }

    public getProtocols(): PurpleProtocol[] {
        return this.protocols;
    }

    public findProtocol(nameOrId: string): PurpleProtocol|undefined {
        nameOrId = nameOrId.toLowerCase();
        return this.getProtocols().find(
            (protocol) => protocol.name.toLowerCase() === nameOrId || protocol.id.toLowerCase() === nameOrId,
        );
    }

    public eventHandler() {
        helper.pollEvents().forEach((evt) => {
            log.debug(`Got ${evt.eventName} from purple`);
            this.emit(evt.eventName, evt);
        });
    }
}
