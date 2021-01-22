'use strict';

// THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. 
// EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES 
// PROVIDE THE PROGRAM “AS IS” WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED,
// INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS 
// FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE 
// PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL 
// NECESSARY SERVICING, REPAIR OR CORRECTION.

// Original Author: Jeffrey Nygaard
// Date: January 21, 2021
// Software Version: 1.0.0
// Contact: jnygaard@nledshop.com
// Copyright© 2021 by Northern Lights Electronic Design, LLC. All Rights Reserved
// Written in vanilla Javascript. May require NodeJS or other runtime enviroment.

//Description: A Javascript library for interfacing with NLED smart devices from web and webview based applications. Please report bugs and
//  contact by email with any suggestions or comments.

//========================================================================================================================================

/* 
TODO:

    Private and Public methods if it ever is implemented. Doesn't really matter for this though.
        
    Add/Test support for websockets(sort of is with TCP IP). Needs testing and refinement.

NOTES:

    Supports standard serial ports, emulated serial ports, bluetooth via transparent bridges(Microchip RN4870 and similar modules)
        and TCP IP using various libraries

    Multiple AuroraDeviceInterface can be created at the same time and commands can be sent to all of them(see example)

    Purposefully wrote it with minimal ECMA script for compatibility, simplicity and readability

    requestXXX - asks the device for data or to preform an action that requires additional data(other than command and data bytes)
    setXXX - executes a command that does not require additional data or expects a return of data
        .setCommand(CMD - Data1 - Data2 - Data3 - Data4 - Confirm Func - PayloadRx Func - Packet Ack Func) 

-----------------------------------------------------------------------------------------------------------------------------------------------

Payload = Block of data to be transfered to or from a device.
PayloadRX = Block of data the software receives from device
PayloadTX = Block of data the software sends to device
Packet = Single chunk of the payload data. Size of chunk depends on device buffer size.

0-Idle
1-Send Command Request:
    Host Sends: "NLED11"
2-Receive Command Request Acknowledge, Send Command Authenticate:
    Host Receives: "a9"
    Host Sends:  "nled99"
3-Receive Command Authenticate Acknowledge, Send Command:
    Host Receives: "f0"
    Host Sends Command: 4 0 0 0
4-Receive Command Acknowledge: 
    Host Receives: "cmd" 0 CMDID#
    Run 'command confirm' callBack: .callBackConfirm
    Either Set state to 5 or 6 depending on sending or receiving payload. 
        Or if command is complete, reset state to idle.
5-Receive PayloadRX Packet:
    Host Receives into .payloadBufferRx: 160,1,2,11,160,123,1
    Run 'payload receive' callBack: .callBackPacketRx
6-Receive PayloadTX Packet Acknowledge:   
    Send packet of .payloadBufferTx
    Receive Device Acknowledge
    Run 'packet acknowledge' callback: .callBackPacketAck
    Repeat with all packets to complete payload transfer

Receive Streamed Payloads
    TBD
*/

//========================================================================================================================================

//may require changing to:
//export default class AuroraDeviceInterface {
class AuroraDeviceInterface {
    //**************************************** Properties ********************************
    constructor(tarPort) {
        //console.log("CLASS CONSTRUCTED with ", tarPort); //DEBUG
        this.state = 0;
        this.cmdByte = 0;
        this.dataByte1 = 0;
        this.dataByte2 = 0;
        this.dataByte3 = 0;
        this.dataByte4 = 0;
        this.timer = null;
        this.timerTime = 3000; //constant in miliseconds, 3 seconds for TCP/BLE(cause reasons), 1 second for serial
        this.callBackConfirm = undefined; //'command confirm' callBack ran after Command Confirmation
        this.callBackPacketRx = undefined; //'packet receive' callBack ran after a Payload packet is received
        this.callBackPacketAck = undefined; //'packet acknowledge' callBack ran after the device has sent a packet acknowledge
        this.fifoBuf = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        this.playloadLen = 0; //number of returned bytes from device
        this.payloadCount = 0; //count of bytes returned from device
        this.packetLen = 0;
        this.packetCount = 0;
        this.payloadBufferRx = [];
        this.payloadBufferTx = [];
        this.progress = 0; //upload/download progress
        this.eventTimeout = undefined; //user defined - action to trigger when the command times out, device does not respond
        this.eventNoPort = undefined; //user defined - action to trigger if a command is issued without an output port(serial,BLE, tcp, etc)
        this.commType = 'uninit';
        this.retryCount = 0; //static retries of 3
        if (tarPort != undefined) this.init(tarPort); //if passed init now, otherwise do it later manually
    } //end constructor

    //**************************************** Base Public Methods ********************************

    init(tarPort) { //public
        //kludgy - checks for parameters to identify port type
        if (tarPort.path != undefined) this.commType = 'serial';
        else if (tarPort.localAddress != undefined) this.commType = 'tcp';
        else if (typeof tarPort.startNotification === 'function') this.commType = 'ble'; //else check for BLE
        else this.commType = 'unknown';

        if (this.commType == 'serial') this.timerTime = 1000; //set serial timeout to 1 second. BLE and TCP may take longer, and is left at the default of 3 seconds

        this.port = tarPort; //only variable passed to constructor. Can be a serial port, tcp client, or OTHER
    }

    setCommand(cmd, b1, b2, b3, b4, cbConfirm, cbPayload, cbPacket) { //public
        if ((this.port != null || this.port != undefined) && this.port.isOpen) {
            if (this.state > 0) {
                console.log("Can not setCommand(), command in progress");   //PRODUCTION
                return false;//false = it was not able to send because a command transmission is in progress
            }
            else {
                console.log("setCommand " + cmd, b1, b2, b3, b4);   //PRODUCTION
                this.callBackConfirm = cbConfirm; //sets up callback parameters
                this.callBackPacketRx = cbPayload; //'packet receive'
                this.callBackPacketAck = cbPacket;
                this.cmdByte = cmd; //Command ID number
                this.dataByte1 = b1; //Command data bytes
                this.dataByte2 = b2;
                this.dataByte3 = b3;
                this.dataByte4 = b4;
                this.timeOutSetup(); //start timer for timeouts... but also need it for zACK....
                this.state = 1; //state = Send Command Request
                this.stateMachine(); // start it
                return true; //true = it was able to send the command
            }
        }
        else {
            console.log("Error - Port is not available. Cannot setCommand() with CMDID: " + cmd); //PRODUCTION
            if (typeof this.eventNoPort === 'function') this.eventNoPort(); //run user defined function if port is not available.
            return false; //false = it was not able to send for some reason
        }
    }

    sendData(arg) { //public
        if (this.port != null && this.port != undefined) {
            //console.log('sendData(), target ' + thisPort.path + ' length: ' + arg.length + '   sending: ' + arg); //DEBUG
            if (this.port.isOpen) {
                //console.log("sendData()", arg); //DEBUG
                if (typeof arg === 'string') this.port.write(arg); //it is a string, send it as is
                else this.port.write(Uint8Array.from(arg)); //or only send typed arrays or buffers. Makes compatible with TCP
            }
            else {
                //console.log("Port Not Open"); //DEBUG
                if (typeof this.eventNoPort === 'function') this.eventNoPort(); //run user defined function if port is not available.
            }
        }
        else {
            //console.log('sendData() failed, no port connected'); //DEBUG
            if (typeof this.eventNoPort === 'function') this.eventNoPort(); //run user defined function if port is not available.
        }
    }

    receiveData(data) {
        if (this.state == 7) this.stateMachine(data); //stream state
        else {
            //Uses FIFO(first in, first out) buffer since the received data can not be guarenteed to arrive in the same event. 
            //  Data could be split across multiple 'data' events, and needs to be processed as a stream, not as a packet.
            for (var i = 0; i < data.length; i++) {
                if (Number.isInteger(data[i])) this.fifoBuf.unshift(data[i]);
                else this.fifoBuf.unshift(data[i].charCodeAt(0)); //add to beginning of array
                this.fifoBuf.pop(); //remove last element
                this.stateMachine();
            }
        }
    }

    timeOutSetup(paramTime = this.timerTime) { //private
        clearTimeout(this.timer); //have to clear it before setting again or will still happen....
        this.timer = setTimeout(function (arg) {
            //could have used a fat arrow => function, then 'this' would reference the class instead of the timer
            //wrote it this way to utilize the lowest(or none?) ECMA script. 'arg' refrences the auroraCMD protocol class
            arg.state = 0; //reset state
            arg.retryCount++;
            if (arg.retryCount < 3) {
                console.log("Command ERROR, retrying", arg.retryCount);
                arg.retryCommand();
            }
            else if (arg.retryCount == 3) {
                console.log(arg.port.path + " - COMMAND or ACK TIMED OUT   State: ", arg.state); //PRODUCTION
                arg.progress = 'err'; // indicates error and to cancel progress bar
                //arg.port.close(); //close the port - not anymore, caused problems. IF the port should close add it to the user defined .eventTimeout()
                arg.resetState();
                if (typeof arg.eventTimeout === 'function') arg.eventTimeout();//user specified function
            }
        }, paramTime, this);
    }

    waitForACK() { //private
        this.timeOutSetup();
        this.state = 6; //state = Receive PayloadTX Packet Acknowledge
    }

    resetState() { //private
        //console.log("RESET STATE"); //DEBUG
        this.state = 0;  //reset all variables and end timeout, so next command starts fresh
        this.fifoBuf.fill(0);
        this.payloadCount = 0;
        this.playloadLen = 0;
        this.packetCount = 0;
        this.packetLen = 0;
        this.retryCount = 0;
        clearTimeout(this.timer);
    }

    //if this method is called from within a method's parameter only as "this.defaultCmdEnd(callback)", it would run right away and not when specifically called
    //  instead always wrapping as "function() { this.defaultCmdEnd(callback) }" when used in a method's parameter made it work correctly. Tried all sorts of things, whatever....
    defaultCmdEnd(callback) { //private
        this.resetState(); //this method runs resetState() along with the user defined function after the command is confirmed.
        if (typeof callback === 'function') callback();
    }

    //Not as fully tested as it should be but appears to work correctly
    retryCommand() { //private
        //console.log("retryCommand ", this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4,); //DEBUG
        this.setCommand(this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4, this.callBackConfirm, this.callBackPacketRx, this.callBackPacketAck);
    }

    stateMachine(streamData) { //private
        //Parses data byte by byte, to ensure that data can arrive at any time. As long as it all arrives within the TimeOut period.
        //console.log("stateMachine with state:", this.state); //DEBUG
        switch (this.state) {
            //-----------------------------------------------------------------------
            default:
                this.state = 0; //error or something occured, reset
            case 0: //Idle
                console.log("Received data dumped. stateMachine state 0/idle"); //PRODUCTION
                //console.log(this.fifoBuf);//DEBUG
                //this.fifoBuf.fill(0);
                break;
            //-----------------------------------------------------------------------
            case 1: //Send Command Request
                this.sendData("NLED11");
                //do reset stuff here so retry works???????????????????????????
                this.state++;
                break;
            //-----------------------------------------------------------------------
            case 2: //Receive Command Request Acknowledge, Send Command Authenticate
                if (this.fifoBuf[1] == 97 && this.fifoBuf[0] == 57) {
                    //console.log("Receive Command Request Acknowledge. Send Command Authenticate"); //DEBUG
                    this.sendData("nled99");
                    this.state++;
                }
                break;
            //-----------------------------------------------------------------------
            case 3: //Receive Command Authenticate Acknowledge, Send Command
                if (this.fifoBuf[1] == 102 && this.fifoBuf[0] == 48) {
                    //console.log("Receive Command Authenticate Acknowledge. Send Command."); //DEBUG
                    this.payloadBufferRx = []; //reset RX buffer
                    this.payloadBufferTx = []; //reset TX buffer

                    var cmdBuffer = [this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4];
                    this.sendData(Uint8Array.from(cmdBuffer));
                    this.state++;
                    this.progress = 0; //now clear it, left to persist until next command starts
                }
                break;
            //-----------------------------------------------------------------------
            case 4: //Receive Command Acknowledge
                if (this.fifoBuf[4] == 99 && this.fifoBuf[3] == 109 && this.fifoBuf[2] == 100 && this.fifoBuf[1] == 0 && this.fifoBuf[0] == this.cmdByte) {
                    //console.log("Received Command Confirmation for CMD# " + this.cmdByte); //DEBUG
                    if (typeof this.callBackConfirm === 'function') this.callBackConfirm(); //run 'command confirm' callback if defined
                    else this.resetState(); //No 'command acknowledge' call back defined, no payload(s) is expected. Run default action, reset state
                }
                else if (this.fifoBuf[2] == 69 && this.fifoBuf[1] == 82 && this.fifoBuf[0] == 82) { //Check for 'ERR'
                    this.state = 0; //reset state
                    this.retryCount++;
                    if (this.retryCount < 3) {
                        console.log("Command ERROR, retrying", this.retryCount);
                        this.retryCommand();
                    }
                    else if (this.retryCount == 3) console.log("Command retry failed, waiting for timeout"); //PRODUCTION
                }
                break;
            //-----------------------------------------------------------------------
            case 5:  //Receive PayloadRX Packet
                //Collect the bytes, move from ring buffer to payloadBuffer
                if (this.payloadCount <= this.playloadLen) {
                    this.payloadCount++;  //collect the required number of bytes via the ring buffer
                    this.payloadBufferRx.push(this.fifoBuf[0]); //keep in payload for some commands
                }
                //The byte just pushed() could be the last one, check
                if (this.payloadCount == this.playloadLen) {
                    //console.log(this.fifoBuf); //DEBUG
                    if (typeof this.callBackPacketRx === 'function') this.callBackPacketRx(); //run 'packet receive' callback if defined
                    else this.resetState(); //No 'packet receive' call back defined. Run default action, reset state
                }
                break;
            //-----------------------------------------------------------------------
            case 6: //Receive PayloadTX Packet Acknowledge
                if (this.fifoBuf[3] == 122 && this.fifoBuf[2] == 65 && this.fifoBuf[1] == 99 && this.fifoBuf[0] == 107) { //'zAck'
                    //console.log("ACK CONFIRMED"); //DEBUG
                    if (typeof this.callBackPacketAck === 'function') this.callBackPacketAck(); //'packet reception' callback defined, run it
                    else this.resetState(); //No 'packet reception' call back defined. Run default action, reset state
                }
                break;
            //-----------------------------------------------------------------------  
            case 7: //Receive Streamed Payloads - this can be streamed to directly without the fifoBuffer
                //not sure if I am keeping this
                //console.log(streamData); //DEBUG
                break;
            //-----------------------------------------------------------------------
        } //end switch
    }

    //******************************************** Localized Helper Functions ***********************************/

    getValue16BitMSB(val) {
        return ((val & 0x0000FF00) >> 8);
    }

    getValue16BitLSB(val) {
        return (val & 0x000000FF);
    }

    //********************************************* Commands *******************************************************/

    requestDeviceConnect(callback) {
        console.log("command - Request Device Connect");
        this.setCommand(4, 0, 0, 0, 0, function () {
            //'command confirm' - increase state to receive payloadRX
            this.playloadLen = 7; //static
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            callback(this.payloadBufferRx);
            this.resetState();
        });
    }
    setIntensity(val, callback) {
        console.log("command - set intensity to " + val);
        this.setCommand(15, val, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setOutputsBlank(mode, callback) {
        console.log("command - Set Outputs Blank" + mode);
        this.setCommand(61, mode, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setSingleLiveControl(chan, val, callback) {
        console.log("command - Set Single Channel Live Control" + chan, val);
        this.setCommand(62, this.getValue16BitMSB(chan), this.getValue16BitLSB(chan), this.getValue16BitMSB(val), this.getValue16BitLSB(val), function () { this.defaultCmdEnd(callback) });
    }
    setSingleLiveControlRelease(chan, callback) {
        console.log("command - Release Single Channel Live Control " + chan);
        this.setCommand(63, this.getValue16BitMSB(chan), this.getValue16BitLSB(chan), 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setSingleLiveControlReleaseAll() {
        console.log("command - Release All Single Channel Live Control");
        this.setCommand(64, 0, 0, 0, 0);
    }
    requestChannelValues(start, num, callback) {
        console.log("command - Get Channel Values", start, num);
        this.setCommand(69, this.getValue16BitMSB(start), this.getValue16BitLSB(start), this.getValue16BitMSB(num), this.getValue16BitLSB(num), function () {
            //'command confirm' - increase state to receive payloadRX
            this.playloadLen = num;
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            callback(this.payloadBufferRx);
            this.resetState();
        });
    }
    setSpeedDecrease(callback) {
        console.log("command - lowering speed!");
        this.setCommand(71, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //change by 1
    }
    setSpeedIncrease(callback) {
        console.log("command - increasing speed!");
        this.setCommand(72, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //change by 1
    }
    setSpeed(val, callback) {
        console.log("command - setting speed to " + val);
        this.setCommand(70, this.getValue16BitMSB(val), this.getValue16BitLSB(val), 0, 0, function () { this.defaultCmdEnd(callback) }); //set to value
    }
    setPlayPauseToggle(callback) {
        console.log("command - play/pause");
        this.setCommand(75, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //toggle
    }
    setPause(callback) {
        console.log("command - set pause");
        this.setCommand(75, 1, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //set play
    }
    setPlay(callback) {
        console.log("command - set play");
        this.setCommand(75, 2, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //set play
    }
    setOnOff(callback) {
        console.log("command -  on/off " + new Date().getMilliseconds()); //toggle
        this.setCommand(76, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setDeviceColorOrder(val, callback) {
        console.log("command - set device color order");
        this.setCommand(81, val, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setStepForward(callback) {
        console.log("command - step forward");
        this.setCommand(82, 1, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //1 = forward
    }
    setStepPrevious(callback) {
        console.log("command - step backward");
        this.setCommand(82, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //0 = backward
    }
    setControlFade(val, callback) {
        this.setCommand(85, this.getValue16BitMSB(val), this.getValue16BitLSB(val), 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setIdleSequence(callback) {
        console.log("command - set to idle sequence");
        this.setCommand(90, 0, 1, 0, 0, function () { this.defaultCmdEnd(callback) }); //set to idle sequence
    }
    setSequenceByID(id, callback) {
        //ID values will be passed base 1, so apply -1 to make it base 0
        console.log("command - select sequence# " + id);
        this.setCommand(90, (id - 1), 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //run command confirm defaulted
    }
    setSequencePrevious(callback) {
        console.log("command - previous sequence");
        this.setCommand(91, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setSequenceNext(callback) {
        console.log("command - next sequence");
        this.setCommand(92, 0, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setChannelsToValue(r, g, b, w, callback) {
        console.log("command - setChannelsToValue", r, g, b, w);
        this.setCommand(111, r, g, b, w, function () { this.defaultCmdEnd(callback) });
    }
    requestADCValue(callback) {
        console.log("command - Request ADC Value");
        this.setCommand(112, 0, 0, 0, 0, function () {
            this.playloadLen = 3; //static - tracker value(100) -> MSB -> LSB
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            callback(this.payloadBufferRx);
            this.resetState();
        });
    }
    setPixelPacketClone(val, callback) {
        console.log("command - set packet clone(pixels only)");
        this.setCommand(10, val, 0, 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    requestConfigUpload(buf, callback) {
        console.log("command - Sending device configurations");
        this.setCommand(101, 0, 0, 0, 0, function () {
            //'command confirm' callBack
            this.sendData(buf);
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
        }, null, function () {
            //run 'packet acknowledge' callBack
            this.defaultCmdEnd(callback);
        });
    }
    requestConfigDownload(buf, callback) {
        console.log("command - Request device's configuration bytes");
        this.setCommand(120, 0, 0, 0, 0, function () {
            //'command confirm' callBack
            if (buf != undefined) this.playloadLen = buf.length; //outdated devices will throw error if undefined
            //this.payloadBufferRx = []; //reset RX buffer
            this.state++;
        }, function () {
            //run 'packet acknowledge' callBack
            callback(this.payloadBufferRx); //call with 'this' reference to the class
            this.resetState();
        });
    }
    setDeviceConfigDefault() {
        console.log("command - Reset Device Configs to default");
        this.setCommand(121, 0, 0, 0, 0);
    }
    setBootloaderMode() {
        console.log("command - Enter device into bootloader mode");
        this.setCommand(140, 0, 0, 0, 0, function () {  //enter device into bootloader, USB connection automatically disconnected
            //'command confirm' callback
            commDisconnectFromPort(); //Close the port since the device just hard reset
            this.resetState();
        });
    }
    setExternalBootloaderMode(callback) {
        console.log("command - Enter External Device to Bootloader");
        this.setCommand(141, 0, 0, 0, 0, function () {  //enter device into bootloader, USB connection automatically disconnected
            //'command confirm' callback
            commDisconnectFromPort(); //Close the port since a different app will have to interface with the port
            this.defaultCmdEnd(callback);
        });
    }
    setUserIDNumber(num, callback) {
        console.log("command - Set User ID to ", num);
        this.setCommand(5, num, 0, 0, 0, function () { this.defaultCmdEnd(callback) }); //set user ID value
    }
    setPulseReception(seqid, frame, callback) {
        console.log("command - Set Sync Pulse");
        this.setCommand(200, seqid, 0, this.getValue16BitMSB(frame), this.getValue16BitLSB(frame), function () { this.defaultCmdEnd(callback) }); //sends sync pulse
    }
    setLiveControlMode(enable, size, chans, callback) {
        console.log("command - Set Live mode - " + enable, chans, size);
        var enFlag = 0; //disable live control
        if (enable == true) enFlag = 1; //enable live control
        var szFlag = 0; //8-bit
        if (size == 16) szFlag = 1; //16-bit
        this.setCommand(60, enFlag, szFlag, this.getValue16BitMSB(chans), this.getValue16BitLSB(chans), function () { this.defaultCmdEnd(callback) }); //set to value
    }
    setLiveControlPacket(buf) {
        //console.log("Sending live packet " + buf.length); //DEBUG
        if (buf.length > stateDevice.soft.channels) {
            console.log("Live Control Packet Upload Error - packet too large");
        }
        else {
            //if (this.state == 0) { this.waitForACK(); sendData(buf); }  //Expects a zACK returned, and data to be sent formatted
            if (this.state == 0) { this.sendData(buf); }  //dropped zAck requirement, was acting strange on some(all?) devices
            //else console.log("Could not send live control packet, command in progress"); //DEBUG
        }
    }
    //Commands Not implemented:
    //Enable Serial Pass Through(110), Set Dot Correction Upload(65)

    //************************************************ PROPRIETARY **********************************************************/

    requestGammaUpload(amount, packetSz, packet, callback) {
        this.setCommand(102, amount, 0, 0, 0, function () {//set user ID value
            //'command confirm' callBack
            //console.log("Gamma Upload confirmation"); //DEBUG
            this.packetLen = amount;
            this.payloadBufferTx = packet; //set this after confirmation when by defualt the buffer is reset
            this.sendData(this.payloadBufferTx.slice(0, packetSz)); //start transmission
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
        }, null, function () {
            //'packet acknowledge' callback
            this.packetCount++;
            //console.log("Packet Ack ", this.packetCount + " of " + this.packetLen); //DEBUG
            if (this.packetCount >= this.packetLen) {
                callback(); //user callback function
                this.resetState();
            }
            else {
                this.timeOutSetup(); //reset timeout for each packet
                this.sendData(this.payloadBufferTx.slice(packetSz * this.packetCount, packetSz * (this.packetCount + 1))); //start transmission
            }
            //messes up progress bar fake - no need really, it wil always be too fast
            //this.progress = Math.ceil((this.packetCount / this.packetLen) * 100); //equals 0 to 100%
        });
    }

    requestHWPVUpload(amount, packetSz, packet, callback) {
        this.setCommand(99, this.getValue16BitMSB(amount), this.getValue16BitLSB(amount), 0, 0, function () {//set user ID value
            //'command confirm' callBack
            //console.log("HWPV confirmation"); //DEBUG
            this.packetLen = amount;
            this.payloadBufferTx = packet; //set this after confirmation when by defualt the buffer is reset
            this.sendData(this.payloadBufferTx.slice(0, packetSz)); //start transmission
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)

        }, null, function () {
            //packet acknowledge callback
            this.packetCount++;
            console.log("Packet Ack ", this.packetCount + " of " + this.packetLen); //DEBUG
            if (this.packetCount >= this.packetLen) {
                callback();
                this.resetState();
            }
            else {
                this.timeOutSetup(); //reset timeout for each packet
                this.sendData(this.payloadBufferTx.slice(packetSz * this.packetCount, packetSz * (this.packetCount + 1))); //start transmission
            }
            //messes up progress bar fake - no need really, it wil always be too fast
            //this.progress = Math.ceil((this.packetCount / this.packetLen) * 100); //equals 0 to 100%
        });
    }

    requestFullUpload(amtIndex, amtSeq, seqPacketSz, indexPacketSz, packetIndex, packetSeq, maxSeq, idleSeq, callback) {
        this.setCommand(100, this.getValue16BitMSB(amtIndex + amtSeq), this.getValue16BitLSB(amtIndex + amtSeq), maxSeq, idleSeq, function () {//request to upload sequences and index
            //'command confirm' callBack
            //console.log("Full Upload Confirmation"); //DEBUG
            this.payloadBufferTx.push(packetIndex); //starts as empty array
            this.payloadBufferTx.push(packetSeq); //merges data sources
            this.packetLen = (amtIndex + amtSeq);
            this.sendData(this.payloadBufferTx[0].slice(0, indexPacketSz)); //start transmission
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
            this.timeOutSetup(10000); //force 10 second timeout in case it needs to erase flash before it starts ACKing. resets to 1 second after first 'packet acknowledge'
        }, null, function () {
            //'packet acknowledge' callback
            //console.log("Aurora Protocol - Packet Ack ", this.packetCount + " of " + this.packetLen); //DEBUG
            this.packetCount++;
            if (this.packetCount >= this.packetLen) {
                callback();
                this.resetState(); //all done sending payload to device
            }
            else {
                this.timeOutSetup(); //reset timeout for each packet
                if (this.packetCount < amtIndex) {
                    this.sendData(this.payloadBufferTx[0].slice(indexPacketSz * this.packetCount, indexPacketSz * (this.packetCount + 1))); //start transmission
                }
                else {
                    var pktCount = this.packetCount - amtIndex; //offset packet count by the number of packets in the index.
                    this.sendData(this.payloadBufferTx[1].slice(seqPacketSz * pktCount, seqPacketSz * (pktCount + 1))); //start transmission
                }
            }
            this.progress = Math.ceil((this.packetCount / this.packetLen) * 100); //for UX - equals 0 to 100%
        });
    }

    //**********************************************************************************************************/
} //end class

//========================================================================================================================================
