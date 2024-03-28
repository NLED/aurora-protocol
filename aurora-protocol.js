"use strict";

// THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. 
// EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES 
// PROVIDE THE PROGRAM “AS IS” WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED,
// INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS 
// FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE 
// PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL 
// NECESSARY SERVICING, REPAIR OR CORRECTION.

// Original Author: Jeffrey Nygaard
// Date: March 27, 2024
// Software Version: 3.0.0
// Contact: jnygaard@nledshop.com
// Copyright© 2024 by Northern Lights Electronic Design, LLC. All Rights Reserved
// Written in vanilla Javascript. May require NodeJS or other runtime enviroment.

//Description: A Javascript library for interfacing with NLED smart devices from web and webview based applications. Please report bugs and
//  contact by email with any suggestions or comments.

//========================================================================================================================================

/*
TODO:

Example browser user interface not thourghly tested or styled.

NOTES:

    Supports standard serial ports, emulated serial ports, bluetooth via transparent bridges(Microchip RN4870 and similar modules)
        and TCP IP

    Multiple NLED devices can be commanded together by constructing multiple AuroraDeviceInterface objects, one for each connected device
        By utilizing the 'User ID' feature, multiple NLED  devices can be identified and found. Regardless of if their serial port name changes
        or the order they are listed.

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
    Run 'command success' callBack: .callBackSuccess
    Set state to 5 or 6 depending on sending or receiving payload. 
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

console.log("NLED Aurora Control Protocol Example Interface v3.0.0");
console.log("Starting NodeJS Server");

//========================================================================================================================================

class AuroraDeviceInterface {
    //**************************************** Properties ********************************
    constructor(comPort) {
        this.state = 0; //Connection States: Not Connected(0) -> Scanned(1) -> Connecting BLE(2) ->Connecting Aurora(3) -> Connected(4) -> Timed Out(5) -> Lost(6)
        this.cmdByte = 0;
        this.dataByte1 = 0;
        this.dataByte2 = 0;
        this.dataByte3 = 0;
        this.dataByte4 = 0;
        this.timer = null;
        this.timerTime = 3000; //constant in miliseconds, 3 seconds for TCP/BLE(cause reasons), 1 second for serial
        this.callBackSuccess = undefined; //'command success' callBack ran after command successation
        this.callBackPacketRx = undefined; //'packet receive' callBack ran after a Payload packet is received
        this.callBackPacketAck = undefined; //'packet acknowledge' callBack ran after the device has sent a packet acknowledge
        this.fifoBuf = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; //first in first out
        this.playloadLen = 0; //number of returned bytes from device
        this.payloadCount = 0; //count of bytes returned from device
        this.packetAmt = 0; //number of packets to be sent or recieved
        this.packetCount = 0; //count number of packets sent or recieved
        this.payloadBufferRx = []; //buffer stores data received from device
        this.payloadBufferTx = []; //buffer contains data to be sent to device
        this.progress = 0; //upload/download progress
        this.eventTimeout = undefined; //user defined - action to trigger when the command times out, device does not respond
        this.eventNoPort = undefined; //user defined - action to trigger if a command is issued without an output port(serial,BLE, tcp, etc)
        this.commType = 'uninit';
        this.retryCount = 0; //static retries of 3
        this.fastMode = false; //when true it doesn't go step-by-step through command requesting, just sends it out all at once. Payloads are still run separatly.
        this.enableLogging = false; //true will make it print messages to console.log
        this.port = null;
        this.queued = [];
        this.enableQueue = true;
        this.liveOpenedChans = 0;
        if (comPort != undefined) this.init(comPort); //if passed init now, otherwise do it later manually
    } //end constructor

    //**************************************** Base Public Methods ********************************

    init(comPort) { //public
        //kludgy - checks for parameters to identify port type
        if (comPort.path != undefined) {
            this.commType = 'serial';
        }
        else if (comPort.localAddress != undefined) this.commType = 'tcp';
        else if (typeof comPort.startNotification === 'function') this.commType = 'ble'; //else check for BLE
        else this.commType = 'unknown';

        this.port = comPort; //only variable passed to constructor. Can be a serial port, tcp client, or OTHER
    }

    log(...msg) {
        //enable or disable when needed
        if (this.enableLogging) console.log(...msg);
    }

    // log = console.log; //DEVELOPMENT

    //Begin command transaction. If a command is issued while another is in progress it will be added to a queue.
    //      If the same command ID is already in the queue, the command data and callbacks are updated 
    setCommand(cmd, b1, b2, b3, b4, cbSuccess, cbPayload, cbPacket) { //public
        if ((this.port != null || this.port != undefined) && this.port.isOpen) {
            if (this.state > 0) {
                if (this.enableQueue) {
                    //add to queue
                    this.log("Aurora Command in progress. Queueing, position: ", this.queued.length);   //PRODUCTION 
                    var qObj = { cmd: cmd, b1: b1, b2: b2, b3: b3, b4: b4, cbSuccess: cbSuccess, cbPayload: cbPayload, cbPacket: cbPacket };

                    var index = -1;
                    for (var i = 0; i < this.queued.length; i++) {
                        if (this.queued[i].cmd == cmd) {
                            //cmd already queued, update it with most recent data
                            index = i; //update index, acts as a 
                            this.queued[i].b1 = b1;
                            this.queued[i].b2 = b2;
                            this.queued[i].b3 = b3;
                            this.queued[i].b4 = b4;
                            this.queued[i].cbSuccess = cbSuccess;
                            this.queued[i].cbPayload = cbPayload;
                            this.queued[i].cbPacket = cbPacket;
                            break; //end loop
                        }
                    } //end for()

                    if (index == -1) this.queued.push(qObj); //cmd was not already queued, push it to queue
                }
                else this.log("Aurora Command in progress. Ignoring.");   //PRODUCTION - Queue not enabled
            }
            else {
                this.log("setCommand " + cmd, b1, b2, b3, b4);   //PRODUCTION
                this.callBackSuccess = cbSuccess; //sets up callback parameters
                this.callBackPacketRx = cbPayload; //'packet receive'
                this.callBackPacketAck = cbPacket;
                this.cmdByte = cmd; //Command ID number
                this.dataByte1 = b1; //Command data bytes
                this.dataByte2 = b2;
                this.dataByte3 = b3;
                this.dataByte4 = b4;
                this.timeOutSetup(); //start timer for timeouts... but also need it for zACK....
                if (this.fastMode) {
                    this.state = 4; //skip to waiting for command acknowledge, then moves on from there normally
                    var sendMsg = Uint8Array.from([78, 76, 69, 68, 49, 49, 110, 108, 101, 100, 57, 57, this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4]); //Unlock bytes "NLED11nled99" then the 5 command bytes
                    this.sendData(sendMsg); //send as one message
                }
                else {
                    this.state = 1; //state = Send Command Request
                    this.stateMachine(); // start it
                }
            }
        }
        else {
            this.log("Error - Port is not available. Cannot setCommand() with CMDID: " + cmd); //PRODUCTION
            if (typeof this.eventNoPort === 'function') this.eventNoPort(); //run user defined function if port is not available.
        }
    }

    sendData(data) { //public
        if (this.port != null && this.port != undefined) {
            //    this.log('sendData(), target ' + this.path + ' length: ' + data.length + '   sending: ' + data); //DEBUG
            if (this.port.isOpen) {
                if (typeof data === 'string') this.port.write(data,);  //it is a string, send it as is
                else this.port.write(Uint8Array.from(data));  //or only send typed arrays or buffers. Makes compatible with TCP
            }
            else {
                //this.log("Port Not Open"); //DEBUG
                if (typeof this.eventNoPort === 'function') this.eventNoPort(); //run user defined function if port is not available.
            }
        }
        else {
            //this.log('sendData() failed, no port connected'); //DEBUG
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
        //console.log("timeOutSetup()", paramTime); //DEBUG
        clearTimeout(this.timer); //have to clear it before setting again or will still happen....
        this.timer = setTimeout(() => {
            // 'this' refrences the aurora command class
            this.state = 0; //reset state
            this.callBackPacketAck = null;

            this.retryCount++;
            if (this.retryCount < 3) {
                this.log("Command timeout, retrying", this.retryCount);
                this.retryCommand();
            }
            else if (this.retryCount == 3) {
                this.log(this.port.path + " - COMMAND or ACK TIMED OUT   State: ", this.state); //PRODUCTION
                this.progress = 'err'; // indicates error and to cancel progress bar
                this.resetState();
                if (typeof this.eventTimeout === 'function') this.eventTimeout();//user specified function
            }
        }, paramTime);
    }

    waitForACK() { //private
        this.timeOutSetup();
        this.state = 6; //state = Receive PayloadTX Packet Acknowledge
    }

    resetState() { //private
        //this.log("RESET STATE"); //DEBUG
        this.state = 0;  //reset all variables and end timeout, so next command starts fresh
        this.fifoBuf.fill(0);
        this.payloadCount = 0;
        this.playloadLen = 0;
        this.packetCount = 0;
        this.packetAmt = 0;
        this.retryCount = 0;
        // this.progress = 100;
        this.progress = 0;
        clearTimeout(this.timer);

        //check and run if any commands are queued
        if (this.queued.length > 0) {
            this.log("Sending Queued command ", this.queued[0].cmd);
            this.setCommand(this.queued[0].cmd, this.queued[0].b1, this.queued[0].b2, this.queued[0].b3, this.queued[0].b4, this.queued[0].cbSuccess, this.queued[0].cbPayload, this.queued[0].cbPacket);
            this.queued.shift();//remove queued object at element 0
        }
    }

    //wrap all calls in anonymous function
    defaultCmdEnd(cbSuccess) { //private
        if (typeof cbSuccess === 'function') cbSuccess();
        this.resetState(); //this method runs resetState() along with the user defined function after the command is confirmed.
    }

    retryCommand() { //private
        //this.log("retryCommand ", this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4,); //DEBUG
        this.setCommand(this.cmdByte, this.dataByte1, this.dataByte2, this.dataByte3, this.dataByte4, this.callBackSuccess, this.callBackPacketRx, this.callBackPacketAck);
    }

    stateMachine(streamData) { //private
        //Parses data byte by byte, to ensure that data can arrive at any time. As long as it all arrives within the TimeOut period.
        //this.log("stateMachine with state:", this.state); //DEBUG
        switch (this.state) {
            //-----------------------------------------------------------------------
            default:
                this.state = 0; //error or something occured, reset
            case 0: //Idle
                this.log("Received data dumped. stateMachine state 0/idle"); //PRODUCTION
                break;
            //-----------------------------------------------------------------------
            case 1: //Send Command Request
                this.sendData("NLED11");
                this.state++;
                break;
            //-----------------------------------------------------------------------
            case 2: //Receive Command Request Acknowledge, Send Command Authenticate
                if (this.fifoBuf[1] == 97 && this.fifoBuf[0] == 57) {
                    //this.log("Receive Command Request Acknowledge. Send Command Authenticate"); //DEBUG
                    this.sendData("nled99");
                    this.state++;
                }
                break;
            //-----------------------------------------------------------------------
            case 3: //Receive Command Authenticate Acknowledge, Send Command
                if (this.fifoBuf[1] == 102 && this.fifoBuf[0] == 48) {
                    //this.log("Receive Command Authenticate Acknowledge. Send Command."); //DEBUG
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
                    //this.log("Received command successation for CMD# " + this.cmdByte); //DEBUG
                    if (typeof this.callBackSuccess === 'function') this.callBackSuccess(); //run 'command success' callback if defined
                    else this.resetState(); //No 'command acknowledge' call back defined, no payload(s) is expected. Run default action, reset state
                }
                else if (this.fifoBuf[2] == 69 && this.fifoBuf[1] == 82 && this.fifoBuf[0] == 82) { //Check for 'ERR'
                    this.state = 0; //reset state
                    this.retryCount++;
                    if (this.retryCount < 3) {
                        this.log("Command Response ERROR, retrying", this.retryCount);
                        this.retryCommand();
                    }
                    else if (this.retryCount == 3) this.log("Command retry failed, waiting for timeout"); //PRODUCTION
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
                    //this.log(this.fifoBuf); //DEBUG
                    if (typeof this.callBackPacketRx === 'function') this.callBackPacketRx(); //run 'packet receive' callback if defined
                    else this.resetState(); //No 'packet receive' call back defined. Run default action, reset state
                }
                else if (this.payloadCount % 1024 == 0) {
                    //arbitrary 1024 bytes increments, reset the timeout and increment the progress
                    this.timeOutSetup();
                    this.progress = Math.ceil((this.payloadCount / this.playloadLen) * 100);
                }

                break;
            //-----------------------------------------------------------------------
            case 6: //Receive PayloadTX Packet Acknowledge
                if (this.fifoBuf[3] == 122 && this.fifoBuf[2] == 65 && this.fifoBuf[1] == 99 && this.fifoBuf[0] == 107) { //'zAck'
                    // this.log("ACK CONFIRMED", this.packetAmt); //DEBUG
                    if (typeof this.callBackPacketAck === 'function') this.callBackPacketAck(); //'packet reception' callback defined, run it
                    else this.resetState(); //No 'packet reception' call back defined. Run default action, reset state
                }
                break;
            //-----------------------------------------------------------------------  
            case 7: //Receive Streamed Payloads - this can be streamed to directly without the fifoBuffer
                //not sure if this state will be used
                //this.log(streamData); //DEBUG
                break;
            //-----------------------------------------------------------------------
        } //end switch
    }

    abort() {
        this.resetState();
        this.progress = 'abort'; //signal command has been aborted
    }

    //******************************************** Localized Helper Functions ***********************************/

    getValue16BitMSB(val) {
        return ((val & 0x0000FF00) >> 8);
    }

    getValue16BitLSB(val) {
        return (val & 0x000000FF);
    }

    //********************************************* Commands *******************************************************/
    
    requestDeviceInfo(cbSuccess) {
        this.log("command - Request Device Connect");
        this.setCommand(4, 0, 0, 0, 0, function () {
            //'command success' callBack- increase state to receive payloadRX
            this.playloadLen = 7; //static
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {

            //STORE firmware version number to check against 

            cbSuccess(this.payloadBufferRx);
            this.resetState();
        });
    }
    requestChannelValues(start, num, cbSuccess) {
        this.log("command - Get Channel Values", start, num);
        this.setCommand(69, this.getValue16BitMSB(start), this.getValue16BitLSB(start), this.getValue16BitMSB(num), this.getValue16BitLSB(num), function () {
            //'command success' callBack- set state to receive payloadRX
            this.playloadLen = num;
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            cbSuccess(this.payloadBufferRx);
            this.resetState();
        });
    }
    requestSerialNumber(cbSuccess) {
        //version 3 or higher
        this.log("command - Request Serial Number");
        this.setCommand(122, 0, 0, 0, 0, function () {
            //'command success' callBack- set state to receive payloadRX
            this.playloadLen = 4;
            this.state = 5;
        }, function () {
            cbSuccess(this.payloadBufferRx);
            this.resetState();
        });
    }
    requestADCValue(cbSuccess) {
        this.log("command - Request ADC Value");
        this.setCommand(112, 0, 0, 0, 0, function () {
            //'command success' callBack - set state to receive payloadRX
            this.playloadLen = 3; //static - frame value(100) -> MSB -> LSB
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            cbSuccess(this.payloadBufferRx);
            this.resetState();
        });
    }
    requestDeviceStatus(cbSuccess) {
        this.log("command - Request Device Status");
        this.setCommand(6, 0, 0, 0, 0, function () {
            this.state = 5; //state = Receive PayloadRX Packet
        }, function () {
            cbSuccess(this.payloadBufferRx);
            this.resetState();
        });
    }
    requestConfigDownload(buf, cbSuccess) {
        this.log("command - Request device's configuration bytes");
        this.setCommand(120, 0, 0, 0, 0, function () {
            //'command success' callBack
            if (buf != undefined) this.playloadLen = buf.length; //outdated devices will throw error if undefined
            this.state++;
        }, function () {
            //run 'packet acknowledge' callBack
            cbSuccess(this.payloadBufferRx); //call with 'this' reference to the class
            this.resetState();
        });
    }
    requestConfigUpload(buf, cbSuccess) {
        this.log("command - Sending device configurations");
        this.setCommand(101, 0, 0, 0, 0, function () {
            //'command success' callBack
            this.sendData(buf);
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
        }, null, function () {
            //run 'packet acknowledge' callBack
            this.defaultCmdEnd(cbSuccess);
        });
    }
    requestFullDownload(cbSuccess) {
        //Downloads the index and sequences stored on the device
        this.log("requestFullDownload()");
        //requires 2 commands, the first requests the size of the data, the second begins the transfer
        this.setCommand(105, 0, 0, 0, 0, function () {
            //'command success' callBack
            this.log("requestFullDownloadPrep() confirmed", this.payloadBufferRx.length);
            this.playloadLen = 4; //static. Device responds with the size of the data transfer in bytes
            this.state++;
        }, function () {
            console.log("packet acknowledge - prep", this.payloadBufferRx);
            this.resetState();
            //the prep command received the size of the data transfer, apply it
            this.playloadLen = (this.payloadBufferRx[0] << 24) | (this.payloadBufferRx[1] << 16) | (this.payloadBufferRx[2] << 8) | (this.payloadBufferRx[3]);
            // console.log(this.playloadLen)

            // console.log(this.payloadCount, this.playloadLen);
            this.setCommand(106, 0, 0, 0, 0, function () {
                //'command success' callBack
                this.log("requestFullDownload() confirmed", this.payloadBufferRx.length);
                this.state++;
            }, function () {
                //run 'packet acknowledge' callBack
                this.resetState();
                console.log("packet acknowledge");
                cbSuccess(this.payloadBufferRx); //call with 'this' reference to the class

            });
        });
    }
    setIntensity(val, cbSuccess) {
        this.log("command - set intensity to ", val);
        this.setCommand(15, val, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setOutputsBlank(mode, cbSuccess) {
        this.log("command - Set Outputs Blank", mode);
        this.setCommand(61, mode, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setSpeedDecrease(cbSuccess) {
        this.log("command - lowering speed!");
        this.setCommand(71, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //change by 1
    }
    setSpeedIncrease(cbSuccess) {
        this.log("command - increasing speed!");
        this.setCommand(72, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //change by 1
    }
    setSpeed(val, cbSuccess) {
        this.log("command - setting speed to " + val);
        this.setCommand(70, this.getValue16BitMSB(val), this.getValue16BitLSB(val), 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //set to value
    }
    setPlayPauseToggle(cbSuccess) {
        this.log("command - play/pause");
        this.setCommand(75, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //toggle
    }
    setPause(cbSuccess) {
        this.log("command - set pause");
        this.setCommand(75, 1, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //set play
    }
    setPlay(cbSuccess) {
        this.log("command - set play");
        this.setCommand(75, 2, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //set play
    }
    setOnOff(cbSuccess) {
        this.log("command - toggle device on/off ");
        this.setCommand(76, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setDeviceColorOrder(val, cbSuccess) {
        this.log("command - set device color order");
        this.setCommand(81, val, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setStepForward(cbSuccess) {
        this.log("command - step forward");
        this.setCommand(82, 1, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //1 = forward
    }
    setStepPrevious(cbSuccess) {
        this.log("command - step backward");
        this.setCommand(82, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //0 = backward
    }
    setControlFade(val, cbSuccess) {
        this.setCommand(85, this.getValue16BitMSB(val), this.getValue16BitLSB(val), 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setFrameNumber(val, flags, cbSuccess) {
        //version 3
        this.log("command - set frame number");
        this.setCommand(86, this.getValue16BitMSB(val), this.getValue16BitLSB(val), flags, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setIdleSequence(cbSuccess) {
        this.log("command - set to idle sequence");
        this.setCommand(90, 0, 1, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //set to idle sequence
    }
    setSequenceByID(id, cbSuccess) {
        //ID values will be passed base 1, so apply -1 to make it base 0
        this.log("command - select sequence# " + id);
        this.setCommand(90, (id - 1), 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //run command success defaulted
    }
    setSequencePrevious(cbSuccess) {
        this.log("command - previous sequence");
        this.setCommand(91, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setSequenceNext(cbSuccess) {
        this.log("command - next sequence");
        this.setCommand(92, 0, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setChannelsToValue(r, g, b, w, cbSuccess) {
        //version 3 or higher
        this.log("command - setChannelsToValue", r, g, b, w);
        this.setCommand(111, r, g, b, w, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setPixelPacketClone(val, cbSuccess) {
        this.log("command - set packet clone(pixels only)");
        this.setCommand(10, val, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) });
    }
    setDeviceConfigDefault() {
        this.log("command - Reset Device Configs to default");
        this.setCommand(121, 0, 0, 0, 0);
    }
    setBootloaderMode(cbSuccess) {
        this.log("command - Enter device into bootloader mode");
        this.setCommand(140, 0, 0, 0, 0, function () {  //enter device into bootloader, USB connection automatically disconnected  
            commDisconnectFromPort(); //Close the port since the device just hard reset
            this.defaultCmdEnd(cbSuccess);
        });
    }
    setExternalBootloaderMode(cbSuccess) {
        this.log("command - Enter External Device to Bootloader");
        this.setCommand(141, 0, 0, 0, 0, function () {  //enter device into bootloader, USB connection automatically disconnected
            commDisconnectFromPort(); //Close the port since a different app will have to interface with the port
            this.defaultCmdEnd(cbSuccess);
        });
    }
    setUserIDNumber(num, cbSuccess) {
        this.log("command - Set User ID to ", num);
        this.setCommand(5, num, 0, 0, 0, function () { this.defaultCmdEnd(cbSuccess) }); //set user ID value
    }
    setLiveControlMode(enable, size, chans, cbSuccess) {
        this.log("command - Set Live mode - " + enable, chans, size);
        var enFlag = 0; //disable live control
        if (enable == true) enFlag = 1; //enable live control
        var szFlag = 0; //8-bit
        if (size == 16) szFlag = 1; //16-bit
        this.setCommand(60, enFlag, szFlag, this.getValue16BitMSB(chans), this.getValue16BitLSB(chans), function () { this.defaultCmdEnd(cbSuccess) }); //set to value
        if (enable) this.liveOpenedChans = chans; //store the number of channels that have been specified for live control
        else this.liveOpenedChans = 0;
    }
    setLiveControlPacket(buf) {
        //Must issue setLiveControlMode() before sending any Live Control Packets
        if (buf.length > this.liveOpenedChans) {
            this.log("Live Control Packet Upload Error - packet larger than specified when setting Live Control mode");
        }
        else {
            if (this.state == 0) { this.sendData(buf); }  //dropped zAck requirement, was acting strange on some(all?) devices
        }
    }
    //Commands Not implemented:
    //Enable Serial Pass Through(110), Set Dot Correction Upload(65)

    //************************************************ DEPRECIATED **********************************************************/
    setPulseReception(seqid, frame, callback) {
        this.log("command - Set Sync Pulse");
        this.setCommand(200, seqid, 0, this.getValue16BitMSB(frame), this.getValue16BitLSB(frame), function () { this.defaultCmdEnd(callback) }); //sends sync pulse
    }
    setSingleLiveControl(chan, val, callback) {
        this.log("command - Set Single Channel Live Control" + chan, val);
        this.setCommand(62, this.getValue16BitMSB(chan), this.getValue16BitLSB(chan), this.getValue16BitMSB(val), this.getValue16BitLSB(val), function () { this.defaultCmdEnd(callback) });
    }
    setSingleLiveControlRelease(chan, callback) {
        this.log("command - Release Single Channel Live Control " + chan);
        this.setCommand(63, this.getValue16BitMSB(chan), this.getValue16BitLSB(chan), 0, 0, function () { this.defaultCmdEnd(callback) });
    }
    setSingleLiveControlReleaseAll() {
        this.log("command - Release All Single Channel Live Control");
        this.setCommand(64, 0, 0, 0, 0);
    }

    //************************************************ PROPRIETARY **********************************************************/

    requestGammaUpload(amount, packetSz, buffer, cbSuccess) {
        this.setCommand(102, amount, 0, 0, 0, function () {
            //'command success' callBack
            //this.log("Gamma Upload confirmation"); //DEBUG
            this.packetAmt = amount;
            this.payloadBufferTx = buffer; //set this after confirmation when by defualt the buffer is reset
            this.sendData(this.payloadBufferTx.slice(0, packetSz)); //start transmission
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
        }, null, function () {
            //'packet acknowledge' callback
            this.packetCount++;
            //this.log("Packet Ack ", this.packetCount + " of " + this.packetAmt); //DEBUG
            if (this.packetCount >= this.packetAmt) {
                this.defaultCmdEnd(cbSuccess);
            }
            else {
                this.timeOutSetup(); //reset timeout for each packet
                this.sendData(this.payloadBufferTx.slice(packetSz * this.packetCount, packetSz * (this.packetCount + 1))); //start transmission
            }
            //this.progress = Math.ceil((this.packetCount / this.packetAmt) * 100); //equals 0 to 100% -  no need , it wil always be too fast
        });
    }

    requestHWPVUpload(packetAmt, packetSz, buffer, cbSuccess) {
        this.setCommand(99, this.getValue16BitMSB(packetAmt), this.getValue16BitLSB(packetAmt), 0, 0, function () {
            //'command success' callBack
            //this.log("HWPV confirmation"); //DEBUG
            this.packetAmt = packetAmt;
            this.payloadBufferTx = buffer; //set this after confirmation when by defualt the buffer is reset
            this.sendData(this.payloadBufferTx.slice(0, packetSz)); //start transmission. packetSz is device defined
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)

        }, null, function () {
            //packet acknowledge callback
            this.packetCount++;
            this.log("Packet Ack ", this.packetCount + " of " + this.packetAmt); //DEBUG
            if (this.packetCount >= this.packetAmt) {
                this.defaultCmdEnd(cbSuccess);
            }
            else {
                this.timeOutSetup(); //reset timeout for each packet
                this.sendData(this.payloadBufferTx.slice(packetSz * this.packetCount, packetSz * (this.packetCount + 1))); //start transmission
            }
            //messes up progress bar fake 
            //this.progress = Math.ceil((this.packetCount / this.packetAmt) * 100); //equals 0 to 100% - no need, it wil always be too fast
        });
    }

    requestFullUpload(amtIndex, amtSeq, seqPacketSz, indexPacketSz, bufferIndex, bufferSeq, maxSeq, idleSeq, cbSuccess) {
        this.setCommand(100, this.getValue16BitMSB(amtIndex + amtSeq), this.getValue16BitLSB(amtIndex + amtSeq), maxSeq, idleSeq, function () {//request to upload sequences and index
            //'command success' callBack
            //this.log("Full Upload Confirmation"); //DEBUG
            this.payloadBufferTx.push(bufferIndex); //starts as empty array
            this.payloadBufferTx.push(bufferSeq); //merges data sources
            this.packetAmt = (amtIndex + amtSeq);

            this.sendData(this.payloadBufferTx[0].slice(0, indexPacketSz)); //start transmission
            this.waitForACK(); //sets state to 6(Receive PayloadTX Packet Acknowledge)
        }, null, function () {
            //'packet acknowledge' callback
            // this.log("Aurora Protocol - Packet Ack ", this.packetCount + " of " + this.packetAmt); //DEBUG
            this.packetCount++;
            if (this.packetCount >= this.packetAmt) {
                //all done sending payload to device
                this.defaultCmdEnd(cbSuccess);
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
            this.progress = Math.ceil((this.packetCount / this.packetAmt) * 100); //for UX - equals 0 to 100%
        });
    }

    //**********************************************************************************************************/
} //end class

//========================================================================================================================================
