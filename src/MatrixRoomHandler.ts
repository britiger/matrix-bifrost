import { Bridge, MatrixRoom, RemoteRoom, MatrixUser, Intent} from "matrix-appservice-bridge";
import { PurpleInstance, PurpleProtocol } from "./purple/PurpleInstance";
import { IPurpleInstance } from "./purple/IPurpleInstance";
import { MROOM_TYPE_IM, MROOM_TYPE_GROUP } from "./StoreTypes";
import { IBridgeContext, IAliasQuery, IAliasQueried } from "./MatrixTypes";
import { IReceivedImMsg, IChatInvite, IChatJoined, IConversationEvent } from "./purple/PurpleEvents";
import { ProfileSync } from "./ProfileSync";
import { Util } from "./Util";
import { Account } from "node-purple";
import { ProtoHacks } from "./ProtoHacks";
import { Logging } from "matrix-appservice-bridge";
import { Store } from "./Store";
import { Deduplicator } from "./Deduplicator";
import { Config } from "./Config";
import * as entityDecode from "parse-entities";
import { MessageFormatter } from "./MessageFormatter";
const log = Logging.get("MatrixRoomHandler");

const ACCOUNT_LOCK_MS = 1000;

/**
 * Handles creation and handling of rooms.
 */
export class MatrixRoomHandler {
    private bridge: Bridge;
    private accountRoomLock: Set<string>;
    constructor(
        private purple: IPurpleInstance,
        private profileSync: ProfileSync,
        private store: Store,
        private config: Config,
        private deduplicator: Deduplicator,
    ) {
        this.accountRoomLock = new Set();
        purple.on("chat-joined", this.onChatJoined.bind(this));
        purple.on("chat-joined-new", async (ev: IChatJoined) => {
            log.info("Handling joining of new chat");
            const matrixUser = await this.store.getMatrixUserForAccount(ev.account);
            if (!matrixUser) {
                log.warn("Got a joined chat for an account not tied to a matrix user. WTF?");
                return;
            }
            const intent = this.bridge.getIntent();
            const roomId = await this.createOrGetGroupChatRoom(ev, intent);
            const memberlist = Object.keys((await this.bridge.getBot().getJoinedMembers(roomId)));
            if (!memberlist.includes(matrixUser.getId())) {
                log.debug(`Invited ${matrixUser.getId()} to a chat they tried to join`);
                await intent.invite(roomId, matrixUser.getId());
            }
        });
        purple.on("received-im-msg", this.handleIncomingIM.bind(this));
        purple.on("received-chat-msg", this.handleIncomingChatMsg.bind(this));
        purple.on("chat-invite", this.handleChatInvite.bind(this));
    }

    /**
     * Set the bridge for us to use. This must be called after MatrixEventHandler
     * has been created.
     * @return [description]
     */
    public setBridge(bridge: Bridge) {
        this.bridge = bridge;
    }

    public onAliasQuery(request: IAliasQuery, context: IBridgeContext) {
        log.debug(`onAliasQuery:`, request);
    }

    public onAliasQueried(request: IAliasQueried, context: IBridgeContext) {
        log.debug(`onAliasQueried:`, request);
    }

    public async onChatJoined(ev: IConversationEvent) {
        this.deduplicator.incrementRoomUsers(ev.conv.name);
        let id = Util.createRemoteId(ev.account.protocol_id, ev.account.username);
        id = `${id}/${ev.conv.name}`;
        this.accountRoomLock.add(id);
        setTimeout(() => {
            log.debug(`AccountLock unlocking ${id}`);
            this.accountRoomLock.delete(id);
        }, ACCOUNT_LOCK_MS);
    }

    private async createOrGetIMRoom(data: IReceivedImMsg, matrixUser: MatrixUser, intent: Intent) {
        // Check to see if we have a room for this IM.
        const roomStore = this.bridge.getRoomStore();
        let remoteData = {
            matrixUser: matrixUser.getId(),
            protocol_id: data.account.protocol_id,
            recipient: data.sender,
        };
        // For some reason the following function wites to remoteData, so recreate it later
        const remoteEntries = await roomStore.getEntriesByRemoteRoomData(remoteData);
        let roomId;
        if (remoteEntries === null || remoteEntries.length === 0) {
            remoteData = {
                matrixUser: matrixUser.getId(),
                protocol_id: data.account.protocol_id,
                recipient: data.sender,
            };
            log.info(`Couldn't find room for IM ${matrixUser.getId()} <-> ${data.sender}. Creating a new one`);
            const res = await intent.createRoom({
                createAsClient: true,
                options: {
                    is_direct: true,
                    name: data.sender,
                    visibility: "private",
                    invite: [matrixUser.getId()],
                },
            });
            roomId = res.room_id;
            log.debug("Created room with id ", roomId);
            const remoteId = Buffer.from(
                `${matrixUser.getId()}:${data.account.protocol_id}:${data.sender}`,
            ).toString("base64");
            log.debug("Storing remote room ", remoteId, " with data ", remoteData);
            const mxRoom = new MatrixRoom(roomId);
            mxRoom.set("type", MROOM_TYPE_IM);
            await roomStore.setMatrixRoom(mxRoom);
            await roomStore.linkRooms(mxRoom, new RemoteRoom(
                remoteId,
            remoteData));
            // Room doesn't exist yet, create it.
        } else {
            if (remoteEntries.length > 1) {
                log.error(
                    `Have multiple matrix rooms assigned for IM ${matrixUser.getId()} <-> ${data.sender}. Bailing`,
                );
                return;
            }
            roomId = remoteEntries[0].matrix.getId();
        }
        return roomId;
    }

    private async createOrGetGroupChatRoom(
        data: IConversationEvent|IChatInvite|IChatJoined,
        intent: Intent,
    ) {
        // Check to see if we have a room for this IM.
        const roomStore = this.bridge.getRoomStore();
        let roomName;
        let props;
        if ("join_properties" in data) {
            roomName = ProtoHacks.getRoomNameForInvite(data);
            props = Object.assign({}, data.join_properties);
        } else {
            roomName = data.conv.name;
        }
        // XXX: This is potentially fragile as we are basically doing a lookup via
        // a set of properties we hope will be unique.
        if (props) {
            ProtoHacks.removeSensitiveJoinProps(data.account.protocol_id, props);
        }
        // Delete a password, if given because we don't need to lookup/store it·
        let remoteData = {
            protocol_id: data.account.protocol_id,
            room_name: roomName,
        };
        // For some reason the following function wites to remoteData, so recreate it later
        const remoteEntries = await roomStore.getEntriesByRemoteRoomData(remoteData);
        let roomId;
        if (remoteEntries === null || remoteEntries.length === 0) {
            remoteData = {
                protocol_id: data.account.protocol_id,
                room_name: roomName,
                properties: ProtoHacks.sanitizeProperties(props), // for joining
            } as any;
            log.info(`Couldn't find room for ${roomName}. Creating a new one`);
            const res = await intent.createRoom({
                createAsClient: false,
                options: {
                    name: roomName,
                    visibility: "private",
                },
            });
            roomId = res.room_id;
            log.debug("Created room with id ", roomId);
            const remoteId = Buffer.from(
                `${data.account.protocol_id}:${roomName}`,
            ).toString("base64");
            log.debug("Storing remote room ", remoteId, " with data ", remoteData);
            const mxRoom = new MatrixRoom(roomId);
            mxRoom.set("type", MROOM_TYPE_GROUP);
            await roomStore.setMatrixRoom(mxRoom);
            await roomStore.linkRooms(mxRoom, new RemoteRoom(
                remoteId,
            remoteData));
            // Room doesn't exist yet, create it.
        } else {
            if (remoteEntries.length > 1) {
                log.error(`Have multiple matrix rooms assigned for chat. Bailing`);
                return;
            }
            roomId = remoteEntries[0].matrix.getId();
        }
        return roomId;
    }

    private async handleIncomingIM(data: IReceivedImMsg) {
        log.debug(`Handling incoming IM from ${data.sender}`);
        data.message = entityDecode(data.message);
        // First, find out who the message was intended for.
        const matrixUser = await this.store.getMatrixUserForAccount(data.account);
        if (matrixUser === null) {
            return;
        }
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        log.debug(`Message intended for ${matrixUser.getId()}`);
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix,
            false,
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        log.debug("Identified ghost user as", senderMatrixUser.getId());
        let roomId;
        try {
            roomId = await this.createOrGetIMRoom(data, matrixUser, intent);
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        // Update the user if needed.
        const account = this.purple.getAccount(data.account.username, data.account.protocol_id)!;
        await this.profileSync.updateProfile(protocol, data.sender,
            account,
        );
        log.debug(`Sending message to ${roomId} as ${senderMatrixUser.getId()}`);
        await intent.sendMessage(roomId, {
            msgtype: "m.text",
            body: data.message,
        });
    }

    private async handleIncomingChatMsg(data: IReceivedImMsg) {
        data.message = entityDecode(data.message);
        const acctId = Util.createRemoteId(data.account.protocol_id, data.account.username);
        if (this.accountRoomLock.has(
            acctId + "/" + data.conv.name)
        ) {
            // This account has recently connected and about to flood the room with
            // messages. We're going to ignore them.
            return;
        }
        const remoteId = Util.createRemoteId(data.account.protocol_id, data.sender);
        if (this.deduplicator.checkAndRemove(
            data.conv.name,
            remoteId,
            data.message,
        )) {
                return;
        }

        if (!this.deduplicator.isTheChosenOneForRoom(data.conv.name, acctId)) {
            return;
        }
        log.debug(`Handling incoming chat from ${data.sender} (${data.conv.name})`);
        // this.purple.getBuddyFromChat(data.conv, data.sender);
        // If multiple of our users are in this room, it may dupe up here.
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix,
            true,
        );
        const account = this.purple.getAccount(data.account.username, data.account.protocol_id)!;
        await this.profileSync.updateProfile(
            protocol,
            data.sender,
            account,
            false,
            ProtoHacks.getSenderIdToLookup(protocol, data.sender, data.conv.name),
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        let roomId;
        try {
            // Note that this will not invite anyone.
            roomId = await this.createOrGetGroupChatRoom(data, intent);
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        await intent.sendMessage(roomId,
            MessageFormatter.messageToMatrixEvent(data.message, protocol),
        );
    }

    private async handleChatInvite(data: IChatInvite) {
        log.debug(`Handling invite to chat from ${data.sender} -> ${data.room_name}`);
        // First, find out who the message was intended for.
        const matrixUser = await this.store.getMatrixUserForAccount(data.account);
        if (matrixUser === null) {
            return;
        }
        const protocol = this.purple.getProtocol(data.account.protocol_id);
        if (!protocol) {
            log.error(`Unknown protocol ${data.account.protocol_id}. Bailing`);
            return;
        }
        const senderMatrixUser = Util.getMxIdForProtocol(
            protocol,
            data.sender,
            this.config.bridge.domain,
            this.config.bridge.userPrefix,
            true,
        );
        const intent = this.bridge.getIntent(senderMatrixUser.getId());
        let roomId;
        // XXX: These chats are shared across multiple matrix users potentially,
        // so remember to invite newbloods.
        try {
            // This will create the room and invite the user.
            roomId = await this.createOrGetGroupChatRoom(data, intent);
            log.debug(`Found room ${roomId} for ${data.room_name}`);
            intent.invite(roomId, matrixUser.getId());
        } catch (e) {
            log.error(`Failed to get/create room for this IM: ${e}`);
            return;
        }
        // XXX: Matrix doesn't support invite messages
        // if (data.message) {
        //     await intent.sendMessage(roomId, {
        //         msgtype: "m.text",
        //         body: data.message,
        //     });
        // }
    }
}
