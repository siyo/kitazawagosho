'use strict';

// node deps
const path = require('path');
const os = require ('os');
const fs = require('fs');

// npm deps
const noble = require('noble');
const Netatmo = require('netatmo');
const Twitter = require('twitter');
const Bravia = require('bravia');
const RaspiCam = require('raspicam');
const _ = require('lodash');
const log = require('npmlog');

// config
// e.g. config.json
// {
//   "twitter":{
//     "consumer_key": "xxxxxxxxxxxxxxx",
//     "consumer_secret": "xxxxxxxxxxxxxxx",
//     "access_token_key": "xxxxxxxxxxxxxxx",
//     "access_token_secret": "xxxxxxxxxxxxxxx"
//   },
//   "netatmo": {
//     "client_id": "xxxxxxxxxxxxxxx",
//     "client_secret": "xxxxxxxxxxxxxxx",
//     "username": "xxxxxxxxxxxxxxx",
//     "password": "xxxxxxxxxxxxxxx"
//   },
//   "bravia": {
//     "IP": '192.168.10.4',
//     "PSK": '0000'
//   }
// }
//
const config = require('./config.json');

const TAG = path.basename(__filename);
const BRAVIA_INTERVAL = 60 * 1000; // msec
const NETATMO_INTERVAL = 333 * 1000; // msec
const CAM_INTERVAL = 15 * 60 * 1000; // msec

const IMG_DIR = '/tmp';
const IMG_FILENAME = 'raspicam.jpg';
const IMG_PATH = IMG_DIR + '/' + IMG_FILENAME;
const INVALID_TEXT_REGEXP = /([\uE000-\uF8FF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDDFF])/g;
//log.level = 'verbose';

class App {
  constructor () {
    this.netatmo = new Netatmo(config.netatmo);
    this.bravia = new Bravia(config.bravia.IP, '80', config.bravia.PSK);
    this.twitter = new Twitter(config.twitter);
    this.cam = new RaspiCam({
      mode: 'photo',
      output: IMG_PATH,
      w: 1280,
      h: 720,
      q: 70,
      e: 'jpg'
    });

    this.luxes = [];
    this.netatmoStatus = '🌬 N/A';
    this.braviaStatus = '📺 N/A';
  }

  start() {
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        noble.startScanning([], true);
      } else {
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      const name = peripheral.advertisement.localName;
      const data = peripheral.advertisement.manufacturerData;
      let val;

      log.verbose(TAG, 'peripheral.advertisement:%j', peripheral.advertisement);

      if (!_.isString(name) || !name.match(/^BLECAST_BL/) || !data)
        return;

      val = data.readUInt8(5) * 256 + data.readUInt8(4);
      this.luxes.push(val);

      log.verbose(TAG, 'MEASURE: %s %d', name, val);
    });

    this.cam.on('start', () => {
      log.info(TAG, 'cam start');
    });

    this.cam.on('stop', () => {
      log.info(TAG, 'cam stop');
    });

    this.cam.on('exit', () => {
      console.log('cam exit');
    });

    this.cam.on('read', (err, timestamp, filename) => {
      this._onCameraRead(err, timestamp, filename);
    });

    log.info(TAG, '=== Start ===');
    this.updateNetatmoStatus()
      .then(() => setInterval(() => this.updateNetatmoStatus(), NETATMO_INTERVAL));
    this.updateBraviaStatus()
      .then(() => setInterval(() => this.updateBraviaStatus(), BRAVIA_INTERVAL));
    this.cam.start();
  }

  async updateNetatmoStatus () {
    try {
      const status = await this._getNetatmoStationData();
      if (this.netatmoStatus !== status) {
        this.netatmoStatus = status;
        this._tweet(`${this.netatmoStatus} ${this.braviaStatus}`);
      }
    } catch(err) {
      this.netatmoStatus = err.message;
      log.error(TAG, err.message);
    }
  }

  async updateBraviaStatus () {
    let braviaStatus = '📺 ';
    try {
      const status = await this._getBraviaStatus();
      braviaStatus += status;
    } catch(err) {
      braviaStatus += err.message;
      log.error(TAG, '%j', err);
    }
    if (this.braviaStatus === braviaStatus )
      return;

    this.braviaStatus = braviaStatus;
    try {
      await this._tweet(`${this.netatmoStatus} ${this.braviaStatus}`);
    } catch(err) {
      log.error(TAG, '%j', err);
    }
  }

  parseNetatmoDevice (device) {
    let status = '';
    const data = device.dashboard_data;

    if (!data) {
      log.warn(TAG, 'data: %j', data);
      return status;
    }

    [
      {key: 'Temperature',  emoji: '🌡', unit: '℃'},
      {key: 'Humidity', emoji: '💧', unit: '%'},
      {key: 'Pressure', emoji: '🎈', unit: 'hPa'},
      {key: 'CO2', emoji: '🌳', unit: 'ppm' },
      {key: 'Noise', emoji: '🔊', unit: 'dB '}
    ].forEach(o => {
      status += o.emoji + ' ' +  data[o.key] + o.unit + ' ';
    });

    return status;
  }

  async _onCameraRead (err, timestamp, filename) {
    if (err) {
      log.error(TAG, err);
    } else {
      log.info(TAG, 'cam saved: %s (%d)', filename, timestamp );
    }
    if (filename !== IMG_FILENAME)
      return;

    let status = `${this.netatmoStatus} ${this.braviaStatus}`;
    let media_ids;
    try {
      const data = fs.readFileSync(IMG_PATH);
      const media = await this.twitter.post('media/upload', {media: data});
      media_ids = media.media_id_string;
    } catch (err) {
      status += '📸' + err.message;
      log.error(TAG, err.message);
    }
    try {
      await this._tweet(status, media_ids);
    } catch (err) {
      log.error(TAG, err.message);
    }
    setTimeout(() => this.cam.start(), CAM_INTERVAL);
  }

  async _tweet(status, media_ids) {
    const st = {
      status: status + ' ⏰ ' + parseInt(_.now() / 1000) + 'UTC'
    };

    if (media_ids)
      st.media_ids = media_ids;

    await this.twitter.post('statuses/update', st);
    log.info(TAG, 'POST: %j', st);
  }

  async _getNetatmoStationData () {
    return new Promise((resolve) => {
      this.netatmo.getStationsData((err, devices) => {
        let status = this._calcLux();
        if (err)
          status += 'Netatmo error! ';
        else
          status += this.parseNetatmoDevice(devices[0]);

        resolve(status);
      });
    });
  }

  async _getBraviaStatus () {
    try {
      const power = await this.bravia.system.invoke('getPowerStatus');
      if (power.status == 'active')  {
        const info = await this.bravia.avContent.invoke('getPlayingContentInfo');
        let status = info.title;
        if (info.programTitle)
          status += ': ' + info.programTitle.replace(INVALID_TEXT_REGEXP, '');
        return status;
      } else  {
        return power.status;
      }
    }catch(err) {
      log.warn(TAG, 'Bravia err' + err);
      return '?';
    }
  }

  _calcLux ()  {
    if (this.luxes.length === 0) {
      return '💡💤' + ' ';
    }
    const total = _.reduce(this.luxes, (memo, lux) => {
      return memo += lux;
    }, 0);

    const val = Math.round(total / this.luxes.length);
    const emoji = val > 2750 ? '☀️' :
          val > 2000 ? '🌤' :
          val > 1000 ? '⛅️' :
          val > 500 ? '☁️' :
          val > 100  ? '💡':
          val > 10 ?  '🕯':
          '👻';

    this.luxes = [];

    return emoji + ' ' + val + ' ';
  }
}

(new App()).start();
