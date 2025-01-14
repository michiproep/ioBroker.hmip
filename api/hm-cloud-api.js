/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

const rq = require('request-promise-native');
const sha512 = require('js-sha512');
const {v4: uuidv4} = require('uuid');
const webSocket = require('ws');

class HmCloudAPI {
    constructor(configDataOrApId, pin) {
        if (configDataOrApId !== undefined) {
            this.parseConfigData(configDataOrApId, pin);
        }

        this.eventRaised = null;
    }

    parseConfigData(configDataOrApId, pin, deviceId) {
        if (typeof configDataOrApId === 'string') {
            this._accessPointSgtin = configDataOrApId.replace(/[^a-fA-F0-9 ]/g, '');
            this._clientAuthToken = sha512(this._accessPointSgtin + "jiLpVitHvWnIGD1yo7MA").toUpperCase();
            this._authToken = '';
            this._clientId = '';

            this._urlREST = '';
            this._urlWebSocket = '';
            this._deviceId = deviceId || uuidv4();
            this._pin = pin;
        } else {
            this._authToken = configDataOrApId.authToken;
            this._clientAuthToken = configDataOrApId.clientAuthToken;
            this._clientId = configDataOrApId.clientId;
            this._accessPointSgtin = configDataOrApId.accessPointSgtin.replace(/[^a-fA-F0-9 ]/g, '');
            this._pin = configDataOrApId.pin;
            this._deviceId = configDataOrApId.deviceId || uuidv4();
        }

        this._clientCharacteristics = {
            "clientCharacteristics":
            {
                "apiVersion": "12",
                "applicationIdentifier": "iobroker",
                "applicationVersion": "1.0",
                "deviceManufacturer": "none",
                "deviceType": "Computer",
                "language": 'en_US',
                "osType": 'Linux',
                "osVersion": 'NT',
            },
            "id": this._accessPointSgtin
        };
    }

    getSaveData() {
        return {
            'authToken': this._authToken,
            'clientAuthToken': this._clientAuthToken,
            'clientId': this._clientId,
            'accessPointSgtin': this._accessPointSgtin,
            'pin': this._pin,
            'deviceId': this._deviceId
        }
    }

    async getHomematicHosts() {
        let res;
        try {
            res = await rq("https://lookup.homematic.com:48335/getHost", {
                method: 'POST',
                json: true,
                body: this._clientCharacteristics
            });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (res && typeof res === 'object') {
            this._urlREST = res.urlREST;
            this._urlWebSocket = res.urlWebSocket;
            if (this._urlWebSocket.startsWith('http')) {
                this._urlWebSocket = 'ws' + this._urlWebSocket.substring(4); // make sure it is ws:// or wss://
            }
        }
        if (!this._urlREST || !this._urlWebSocket) {
            throw "Could not get host details. Please check the SGTIN.";
        }
    }

    // =========== API for Token generation ===========

    async auth1connectionRequest(devicename = 'hmipnodejs') {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        if (this._pin)
            headers['PIN'] = this._pin;
        const body = { "deviceId": this._deviceId, "deviceName": devicename, "sgtin": this._accessPointSgtin };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/connectionRequest", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        if (!res || res.statusCode !== 200)
            throw "error";
    }

    async auth2isRequestAcknowledged() {
        const headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        const body = { "deviceId": this._deviceId };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/isRequestAcknowledged", { method: 'POST', json: true, body: body, headers: headers, simple: false, resolveWithFullResponse: true });
        } catch (err) {
            this.requestError && this.requestError(err);
        }
        return res && typeof res === 'object' && res.statusCode === 200;
    }

    async auth3requestAuthToken() {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'CLIENTAUTH': this._clientAuthToken };
        let body = { "deviceId": this._deviceId };
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/auth/requestAuthToken", { method: 'POST', json: true, body: body, headers: headers });
            this._authToken = res.authToken;
            body = { "deviceId": this._deviceId, "authToken": this._authToken };
            res = await rq(this._urlREST + "/hmip/auth/confirmAuthToken", { method: 'POST', json: true, body: body, headers: headers });
            this._clientId = res.clientId;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    async callRestApi(path, data) {
        let headers = { 'content-type': 'application/json', 'accept': 'application/json', 'VERSION': '12', 'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken};
        let res;
        try {
            res = await rq(this._urlREST + "/hmip/" + path, { method: 'POST', json: true, body: data, headers: headers });
            return res;
        } catch (err) {
            this.requestError && this.requestError(err);
        }
    }

    // =========== API for HM ===========

    async loadCurrentConfig() {
        let state = await this.callRestApi('home/getCurrentState', this._clientCharacteristics);
        if (state)
        {
            this.home = state.home;
            this.groups = state.groups;
            this.clients = state.clients;
            this.devices = state.devices;
        } else {
            throw new Error('No current State received');
        }
    }

    // =========== Event Handling ===========

    dispose() {
        this.isClosed = true;
        if (this._ws) {
            this._ws.close();
        }
        if (this._connectTimeout)
            clearTimeout(this._connectTimeout);
        if (this._pingInterval)
            clearInterval(this._pingInterval);
    }

    connectWebsocket() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        this._ws = new webSocket(this._urlWebSocket, {
            headers: {
                'AUTHTOKEN': this._authToken, 'CLIENTAUTH': this._clientAuthToken
            },
            perMessageDeflate: false
        });

        this._ws.on('open', () => {
            if (this.opened)
                this.opened();

            this._pingInterval && clearInterval(this._pingInterval);
            this._pingInterval = setInterval(() => {
                this._ws.ping(() => { });
            }, 5000);
        });

        this._ws.on('close', (code, reason) => {
            if (this.closed)
                this.closed(code, reason.toString('utf8'));
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 10000);
            }
        });

        this._ws.on('error', (error) => {
            if (this.errored)
                this.errored(error);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 10000);
            }
        });

        this._ws.on('unexpected-response', (request, response) => {
            if (this.unexpectedResponse)
                this.unexpectedResponse(request, response);
            if (this._pingInterval) {
                clearInterval(this._pingInterval);
                this._pingInterval = null;
            }
            if (!this.isClosed) {
                this._connectTimeout && clearTimeout(this._connectTimeout);
                this._connectTimeout = setTimeout(() => this.connectWebsocket(), 10000);
            }
        });

        this._ws.on('message', (d) => {
            let dString = d.toString('utf8');
            if (this.dataReceived)
                this.dataReceived(dString);
            let data = JSON.parse(dString);
            this._parseEventdata(data);
        });

        this._ws.on('ping', () => {
            if (this.dataReceived)
                this.dataReceived("ping");
        });

        this._ws.on('pong', () => {
            if (this.dataReceived)
                this.dataReceived("pong");
        });
    }

    _parseEventdata(data) {
        for (let i in data.events) {
            let ev = data.events[i];
            switch (ev.pushEventType) {
                case 'DEVICE_ADDED':
                case 'DEVICE_CHANGED':
                    if (ev.device) {
                        this.devices[ev.device.id] = ev.device;
                    }
                    break;
                case 'GROUP_ADDED':
                case 'GROUP_CHANGED':
                    if (ev.group) {
                        this.groups[ev.group.id] = ev.group;
                    }
                    break;
                case 'CLIENT_ADDED':
                case 'CLIENT_CHANGED':
                    if (ev.client) {
                        this.clients[ev.client.id] = ev.client;
                    }
                    break;
                case 'DEVICE_REMOVED':
                    ev.device && delete this.devices[ev.device.id];
                    break;
                case 'GROUP_REMOVED':
                    ev.group && delete this.clients[ev.group.id];
                    break;
                case 'CLIENT_REMOVED':
                    ev.client && delete this.groups[ev.client.id];
                    break;
                case 'HOME_CHANGED':
                    this.home = ev.home;
                    break;
            }
            if (this.eventRaised)
                this.eventRaised(ev);
        }
    }

    // =========== API for HM Devices ===========

    // boolean
    async deviceControlSetSwitchState(deviceId, on, channelIndex = 1) {
        let data = { "deviceId": deviceId, "on": on, "channelIndex": channelIndex };
        await this.callRestApi('device/control/setSwitchState', data);
    }

    // door commands as number: 1 = open; 2 = stop; 3 = close; 4 = ventilation position
    // DoorState
    //     CLOSED = auto()
    //     OPEN = auto()
    //     VENTILATION_POSITION = auto()
    //     POSITION_UNKNOWN = auto()
    //
    // DoorCommand
    //     OPEN = auto()
    //     STOP = auto()
    //     CLOSE = auto()
    //     PARTIAL_OPEN = auto()
    async deviceControlSendDoorCommand(deviceId, doorCommand, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'doorCommand': doorCommand };
        await this.callRestApi('device/control/sendDoorCommand', data);
    }

    async deviceControlSetLockState(deviceId, lockState, pin, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'authorizationPin': pin.toString(), 'targetLockState': lockState };
        await this.callRestApi('device/control/setLockState', data);
    }

    async deviceControlResetEnergyCounter(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/resetEnergyCounter', data);
    }

    async deviceConfigurationSetOperationLock(deviceId, operationLock, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'operationLock': operationLock };
        await this.callRestApi('device/configuration/setOperationLock', data);
    }

    // ClimateControlDisplay
    //     ACTUAL = auto()
    //     SETPOINT = auto()
    //     ACTUAL_HUMIDITY = auto()
    async deviceConfigurationSetClimateControlDisplay(deviceId, display, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'display': display };
        await this.callRestApi('device/configuration/setClimateControlDisplay', data);
    }

    // float 0.0-1.0
    async deviceConfigurationSetMinimumFloorHeatingValvePosition(deviceId, minimumFloorHeatingValvePosition, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'minimumFloorHeatingValvePosition': minimumFloorHeatingValvePosition };
        await this.callRestApi('device/configuration/setMinimumFloorHeatingValvePosition', data);
    }

    // float 0.0-1.0??
    async deviceControlSetDimLevel(deviceId, dimLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'dimLevel': dimLevel };
        await this.callRestApi('device/control/setDimLevel', data);
    }

    // float 0.0-1.0??
    async deviceControlSetRgbDimLevel(deviceId, rgb, dimLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'simpleRGBColorState': rgb, 'dimLevel': dimLevel };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevel', data);
    }

    // float 0.0-1.0??
    // not used right now
    async deviceControlSetRgbDimLevelWithTime(deviceId, rgb, dimLevel, onTime, rampTime, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'simpleRGBColorState': rgb, 'dimLevel': dimLevel, 'onTime': onTime, 'rampTime': rampTime };
        await this.callRestApi('device/control/setSimpleRGBColorDimLevelWithTime', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlSetShutterLevel(deviceId, shutterLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'shutterLevel': shutterLevel };
        await this.callRestApi('device/control/setShutterLevel', data);
    }

    async deviceControlStartImpulse(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/startImpulse', data);
    }

    // float 0.0 = open - 1.0 = closed
    async deviceControlSetSlatsLevel(deviceId, slatsLevel, shutterLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'slatsLevel': slatsLevel, 'shutterLevel': shutterLevel };
        await this.callRestApi('device/control/setSlatsLevel', data);
    }

    async deviceControlStop(deviceId, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex };
        await this.callRestApi('device/control/stop', data);
    }

    async deviceControlSetPrimaryShadingLevel(deviceId, primaryShadingLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'primaryShadingLevel': primaryShadingLevel };
        await this.callRestApi('device/control/setPrimaryShadingLevel', data);
    }

    async deviceControlSetSecondaryShadingLevel(deviceId, primaryShadingLevel, secondaryShadingLevel, channelIndex = 1) {
        let data = { "deviceId": deviceId, "channelIndex": channelIndex, 'primaryShadingLevel': primaryShadingLevel, 'secondaryShadingLevel': secondaryShadingLevel };
        await this.callRestApi('device/control/setSecondaryShadingLevel', data);
    }

    // AcousticAlarmSignal
    //     DISABLE_ACOUSTIC_SIGNAL = auto()
    //     FREQUENCY_RISING = auto()
    //     FREQUENCY_FALLING = auto()
    //     FREQUENCY_RISING_AND_FALLING = auto()
    //     FREQUENCY_ALTERNATING_LOW_HIGH = auto()
    //     FREQUENCY_ALTERNATING_LOW_MID_HIGH = auto()
    //     FREQUENCY_HIGHON_OFF = auto()
    //     FREQUENCY_HIGHON_LONGOFF = auto()
    //     FREQUENCY_LOWON_OFF_HIGHON_OFF = auto()
    //     FREQUENCY_LOWON_LONGOFF_HIGHON_LONGOFF = auto()
    //     LOW_BATTERY = auto()
    //     DISARMED = auto()
    //     INTERNALLY_ARMED = auto()
    //     EXTERNALLY_ARMED = auto()
    //     DELAYED_INTERNALLY_ARMED = auto()
    //     DELAYED_EXTERNALLY_ARMED = auto()
    //     EVENT = auto()
    //     ERROR = auto()
    async deviceConfigurationSetAcousticAlarmSignal(deviceId, acousticAlarmSignal, channelIndex = 1) {
        let data = { "deviceId": deviceId, "acousticAlarmSignal": acousticAlarmSignal, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmSignal', data);
    }

    // AcousticAlarmTiming
    //     PERMANENT = auto()
    //     THREE_MINUTES = auto()
    //     SIX_MINUTES = auto()
    //     ONCE_PER_MINUTE = auto()
    async deviceConfigurationSetAcousticAlarmTiming(deviceId, acousticAlarmTiming, channelIndex = 1) {
        let data = { "deviceId": deviceId, "acousticAlarmTiming": acousticAlarmTiming, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAcousticAlarmTiming', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetAcousticWaterAlarmTrigger(deviceId, acousticWaterAlarmTrigger, channelIndex = 1) {
        let data = { "deviceId": deviceId, "acousticWaterAlarmTrigger": acousticWaterAlarmTrigger, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAcousticWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetInAppWaterAlarmTrigger(deviceId, inAppWaterAlarmTrigger, channelIndex = 1) {
        let data = { "deviceId": deviceId, "inAppWaterAlarmTrigger": inAppWaterAlarmTrigger, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setInAppWaterAlarmTrigger', data);
    }

    // WaterAlarmTrigger
    //     NO_ALARM = auto()
    //     MOISTURE_DETECTION = auto()
    //     WATER_DETECTION = auto()
    //     WATER_MOISTURE_DETECTION = auto()
    async deviceConfigurationSetSirenWaterAlarmTrigger(deviceId, sirenWaterAlarmTrigger, channelIndex = 1) {
        let data = { "deviceId": deviceId, "sirenWaterAlarmTrigger": sirenWaterAlarmTrigger, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setSirenWaterAlarmTrigger', data);
    }

    // AccelerationSensorMode
    //     ANY_MOTION = auto()
    //     FLAT_DECT = auto()
    async deviceConfigurationSetAccelerationSensorMode(deviceId, accelerationSensorMode, channelIndex = 1) {
        let data = { "deviceId": deviceId, "accelerationSensorMode": accelerationSensorMode, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorMode', data);
    }

    // AccelerationSensorNeutralPosition
    //     HORIZONTAL = auto()
    //     VERTICAL = auto()
    async deviceConfigurationSetAccelerationSensorNeutralPosition(deviceId, accelerationSensorNeutralPosition, channelIndex = 1) {
        let data = { "deviceId": deviceId, "accelerationSensorNeutralPosition": accelerationSensorNeutralPosition, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorNeutralPosition', data);
    }

    // accelerationSensorTriggerAngle = int
    async deviceConfigurationSetAccelerationSensorTriggerAngle(deviceId, accelerationSensorTriggerAngle, channelIndex = 1) {
        let data = { "deviceId": deviceId, "accelerationSensorTriggerAngle": accelerationSensorTriggerAngle, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorTriggerAngle', data);
    }

    // AccelerationSensorSensitivity
    //     SENSOR_RANGE_16G = auto()
    //     SENSOR_RANGE_8G = auto()
    //     SENSOR_RANGE_4G = auto()
    //     SENSOR_RANGE_2G = auto()
    //     SENSOR_RANGE_2G_PLUS_SENS = auto()
    //     SENSOR_RANGE_2G_2PLUS_SENSE = auto()
    async deviceConfigurationSetAccelerationSensorSensitivity(deviceId, accelerationSensorSensitivity, channelIndex = 1) {
        let data = { "deviceId": deviceId, "accelerationSensorSensitivity": accelerationSensorSensitivity, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorSensitivity', data);
    }

    // accelerationSensorEventFilterPeriod = float
    async deviceConfigurationSetAccelerationSensorEventFilterPeriod(deviceId, accelerationSensorEventFilterPeriod, channelIndex = 1) {
        let data = { "deviceId": deviceId, "accelerationSensorEventFilterPeriod": accelerationSensorEventFilterPeriod, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setAccelerationSensorEventFilterPeriod', data);
    }

    // NotificationSoundType
    //     SOUND_NO_SOUND = auto()
    //     SOUND_SHORT = auto()
    //     SOUND_SHORT_SHORT = auto()
    //     SOUND_LONG = auto()
    async deviceConfigurationSetNotificationSoundTyp(deviceId, notificationSoundType, isHighToLow, channelIndex = 1) {
        let data = { "deviceId": deviceId, "notificationSoundType": notificationSoundType, "isHighToLow": isHighToLow, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setNotificationSoundTyp', data);
    }

    async deviceConfigurationSetRouterModuleEnabled(deviceId, routerModuleEnabled, channelIndex = 1) {
        let data = { "deviceId": deviceId, "routerModuleEnabled": routerModuleEnabled, "channelIndex": channelIndex };
        await this.callRestApi('device/configuration/setRouterModuleEnabled', data);
    }

    async deviceDeleteDevice(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/deleteDevice', data);
    }

    async deviceSetDeviceLabel(deviceId, label) {
        let data = { "deviceId": deviceId, "label": label };
        await this.callRestApi('device/setDeviceLabel', data);
    }

    async deviceIsUpdateApplicable(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/isUpdateApplicable', data);
    }

    async deviceAuthorizeUpdate(deviceId) {
        let data = { "deviceId": deviceId };
        await this.callRestApi('device/authorizeUpdate', data);
    }

    // =========== API for HM Groups ===========

    async groupHeatingSetPointTemperature(groupId, setPointTemperature) {
        let data = { "groupId": groupId, "setPointTemperature": setPointTemperature };
        await this.callRestApi('group/heating/setSetPointTemperature', data);
    }

    async groupHeatingSetBoostDuration(groupId, boostDuration) {
        let data = { "groupId": groupId, "boostDuration": boostDuration };
        await this.callRestApi('group/heating/setBoostDuration', data);
    }

    async groupHeatingSetBoost(groupId, boost) {
        let data = { "groupId": groupId, "boost": boost };
        await this.callRestApi('group/heating/setBoost', data);
    }

    async groupHeatingSetControlMode(groupId, controlMode) {
        let data = { "groupId": groupId, "controlMode": controlMode };
        //AUTOMATIC,MANUAL
        await this.callRestApi('group/heating/setControlMode', data);
    }

    async groupHeatingSetActiveProfile(groupId, profileIndex) {
        let data = { "groupId": groupId, "profileIndex": profileIndex };
        await this.callRestApi('group/heating/setActiveProfile', data);
    }

    async groupSwitchingAlarmSetOnTime(groupId, onTime) {
        let data ={"groupId": groupId, "onTime": onTime};
        await this.callRestApi('group/switching/alarm/setOnTime', data);
    }

    async groupSwitchingAlarmTestSignalOptical(groupId, signalOptical) {
        let data = { "groupId": groupId, "signalOptical": signalOptical };
        await this.callRestApi('group/switching/alarm/testSignalOptical', data);
    }

    async groupSwitchingAlarmSetSignalOptical(groupId, signalOptical) {
        let data = { "groupId": groupId, "signalOptical": signalOptical };
        await this.callRestApi('group/switching/alarm/setSignalOptical', data);
    }

    async groupSwitchingAlarmTestSignalAcoustic(groupId, signalAcoustic) {
        let data = { "groupId": groupId, "signalAcoustic": signalAcoustic };
        await this.callRestApi('group/switching/alarm/testSignalAcoustic', data);
    }

    async groupSwitchingAlarmSetSignalAcoustic(groupId, signalAcoustic) {
        let data = { "groupId": groupId, "signalAcoustic": signalAcoustic };
        await this.callRestApi('group/switching/alarm/setSignalAcoustic', data);
    }

    // =========== API for HM Clients ===========

    async clientDeleteClient(clientId) {
        let data = { "clientId": clientId };
        await this.callRestApi('client/deleteClient', data);
    }

    // =========== API for HM Home ===========

    async homeHeatingActivateAbsenceWithPeriod(endTime) {
        let data = { "endTime": endTime };
        await this.callRestApi('home/heating/activateAbsenceWithPeriod', data);
    }

    async homeHeatingActivateAbsenceWithDuration(duration) {
        let data = { "duration": duration };
        await this.callRestApi('home/heating/activateAbsenceWithDuration', data);
    }

    async homeHeatingActivateAbsencePermanent() {
        await this.callRestApi('home/heating/activateAbsencePermanent');
    }

    async homeHeatingDeactivateAbsence() {
        await this.callRestApi('home/heating/deactivateAbsence');
    }

    async homeHeatingActivateVacation(temperature, endtime) {
        let data = { "temperature": temperature, "endtime": endtime };
        await this.callRestApi('home/heating/activateVacation', data);
    }

    async homeHeatingDeactivateVacation() {
        await this.callRestApi('home/heating/deactivateVacation');
    }

    async homeSetIntrusionAlertThroughSmokeDetectors(intrusionAlertThroughSmokeDetectors) {
        let data = { "intrusionAlertThroughSmokeDetectors": intrusionAlertThroughSmokeDetectors};
        await this.callRestApi('home/security/setIntrusionAlertThroughSmokeDetectors', data);
    }

    async homeSetZonesActivation(internal, external) {
        let data = { "zonesActivation": { "INTERNAL": internal, "EXTERNAL": external } };
        await this.callRestApi('home/security/setZonesActivation', data);
    }
}

module.exports = HmCloudAPI;
