import { OCPPErrorType, OCPPMessageType } from '../../../types/ocpp/OCPPCommon';
import { OCPPProtocol, OCPPVersion, RegistrationStatus } from '../../../types/ocpp/OCPPServer';
import { ServerAction, WSServerProtocol } from '../../../types/Server';
import WebSocket, { CloseEvent, ErrorEvent } from 'ws';

import BackendError from '../../../exception/BackendError';
import ChargingStationClient from '../../../client/ocpp/ChargingStationClient';
import ChargingStationStorage from '../../../storage/mongodb/ChargingStationStorage';
import Configuration from '../../../utils/Configuration';
import JsonCentralSystemServer from './JsonCentralSystemServer';
import JsonChargingStationClient from '../../../client/ocpp/json/JsonChargingStationClient';
import JsonChargingStationService from './services/JsonChargingStationService';
import Logging from '../../../utils/Logging';
import OCPPError from '../../../exception/OcppError';
import { OCPPHeader } from '../../../types/ocpp/OCPPHeader';
import Utils from '../../../utils/Utils';
import WSConnection from './WSConnection';
import http from 'http';

const MODULE_NAME = 'JsonWSConnection';

export default class JsonWSConnection extends WSConnection {
  public isConnectionAlive: boolean;
  private chargingStationClient: ChargingStationClient;
  private chargingStationService: JsonChargingStationService;
  private headers: OCPPHeader;

  constructor(wsConnection: WebSocket, req: http.IncomingMessage, wsServer: JsonCentralSystemServer) {
    // Call super
    super(wsConnection, req, wsServer);
    // Check Protocol (required field of OCPP spec)
    switch (wsConnection.protocol) {
      // OCPP 1.6?
      case WSServerProtocol.OCPP16:
        // Create the Json Client
        this.chargingStationClient = new JsonChargingStationClient(this, this.getTenantID(), this.getChargingStationID());
        // Create the Json Server Service
        this.chargingStationService = new JsonChargingStationService();
        break;
      // Not Found
      default:
        // Error
        throw new BackendError({
          source: this.getChargingStationID(),
          module: MODULE_NAME,
          method: 'constructor',
          message: `Protocol ${wsConnection.protocol} not supported`
        });
    }
    this.isConnectionAlive = true;
    // Handle Socket ping
    this.getWSConnection().on('ping', this.onPing.bind(this));
    // Handle Socket pong
    this.getWSConnection().on('pong', this.onPong.bind(this));
  }

  public async initialize(): Promise<void> {
    // Already initialized?
    if (!this.initialized) {
      // Call super class
      await super.initialize();
      // Initialize the default Headers
      this.headers = {
        chargeBoxIdentity: this.getChargingStationID(),
        ocppVersion: (this.getWSConnection().protocol.startsWith('ocpp') ? this.getWSConnection().protocol.replace('ocpp', '') : this.getWSConnection().protocol) as OCPPVersion,
        ocppProtocol: OCPPProtocol.JSON,
        chargingStationURL: Configuration.getJsonEndpointConfig().baseSecureUrl
          ? Configuration.getJsonEndpointConfig().baseSecureUrl
          : Configuration.getJsonEndpointConfig().baseUrl,
        tenantID: this.getTenantID(),
        token: this.getToken(),
        From: {
          Address: this.getClientIP()
        }
      };
      // Ok
      this.initialized = true;
      // Log
      await Logging.logInfo({
        tenantID: this.getTenantID(),
        source: this.getChargingStationID(),
        action: ServerAction.WS_JSON_CONNECTION_OPENED,
        module: MODULE_NAME, method: 'initialize',
        message: `New Json connection from '${this.getClientIP().toString()}', Protocol '${this.getWSConnection().protocol}', URL '${this.getURL()}'`
      });
    }
  }

  public onError(errorEvent: ErrorEvent): void {
    // Log
    void Logging.logError({
      tenantID: this.getTenantID(),
      source: this.getChargingStationID() ? this.getChargingStationID() : '',
      action: ServerAction.WS_JSON_CONNECTION_ERROR,
      module: MODULE_NAME, method: 'onError',
      message: `Error ${errorEvent?.error} ${errorEvent?.message}`,
      detailedMessages: { errorEvent: errorEvent }
    });
  }

  public onClose(closeEvent: CloseEvent): void {
    // Log
    void Logging.logInfo({
      tenantID: this.getTenantID(),
      source: this.getChargingStationID() ? this.getChargingStationID() : '',
      action: ServerAction.WS_JSON_CONNECTION_CLOSED,
      module: MODULE_NAME, method: 'onClose',
      message: `Connection has been closed, Reason: '${closeEvent.reason ? closeEvent.reason : 'No reason given'}', Message: '${Utils.getWebSocketCloseEventStatusString(Utils.convertToInt(closeEvent))}', Code: '${closeEvent.toString()}'`,
      detailedMessages: { closeEvent: closeEvent }
    });
    // Remove the connection
    this.wsServer.removeJsonConnection(this);
  }

  public async onPing(): Promise<void> {
    await this.updateChargingStationLastSeen();
  }

  public async onPong(): Promise<void> {
    this.isConnectionAlive = true;
    await this.updateChargingStationLastSeen();
  }

  public async handleRequest(messageId: string, commandName: ServerAction, commandPayload: Record<string, unknown> | string): Promise<void> {
    // Log
    await Logging.logChargingStationServerReceiveAction(MODULE_NAME, this.getTenantID(), this.getChargingStationID(), commandName, commandPayload);
    const methodName = `handle${commandName}`;
    // Check if method exist in the service
    if (typeof this.chargingStationService[methodName] === 'function') {
      if ((commandName === 'BootNotification') || (commandName === 'Heartbeat')) {
        this.headers.currentIPAddress = this.getClientIP();
      }
      // Call it
      const result = await this.chargingStationService[methodName](this.headers, commandPayload);
      // Log
      await Logging.logChargingStationServerRespondAction(MODULE_NAME, this.getTenantID(), this.getChargingStationID(), commandName, result);
      // Send Response
      await this.sendMessage(messageId, result, OCPPMessageType.CALL_RESULT_MESSAGE, commandName);
    } else {
      // Throw Exception
      throw new OCPPError({
        source: this.getChargingStationID(),
        module: MODULE_NAME,
        method: 'handleRequest',
        code: OCPPErrorType.NOT_IMPLEMENTED,
        message: `The OCPP method 'handle${typeof commandName === 'string' ? commandName : JSON.stringify(commandName)}' has not been implemented`
      });
    }
  }

  public getChargingStationClient(): ChargingStationClient {
    // Only return client if WS is open
    if (this.isWSConnectionOpen()) {
      return this.chargingStationClient;
    }
    void Logging.logError({
      tenantID: this.getTenantID(),
      source: this.getChargingStationID(),
      module: MODULE_NAME, method: 'getChargingStationClient',
      action: ServerAction.WS_CONNECTION,
      message: `Cannot retrieve WS client from WS connection with status '${this.getConnectionStatusString()}'`,
    });
    return null;
  }

  private async updateChargingStationLastSeen(): Promise<void> {
    const chargingStation = await ChargingStationStorage.getChargingStation(this.getTenantID(), this.getChargingStationID(), { issuer: true });
    if (chargingStation) {
    // if (chargingStation?.registrationStatus === RegistrationStatus.ACCEPTED) {
      await ChargingStationStorage.saveChargingStationLastSeen(this.getTenantID(), this.getChargingStationID(),
        {
          lastSeen: new Date()
        });
    }
  }
}

