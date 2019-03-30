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
const NETATOMO_INTERVAL = 5 * 60 * 1000; // msec
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
      var name = peripheral.advertisement.localName,
          data = peripheral.advertisement.manufacturerData;
      var val;

      log.verbose(TAG, 'peripheral.advertisement:%j', peripheral.advertisement);

      if (!_.isString(name) || !name.match(/^BLECAST_BL/) || !data)
        return;

      val = data.readUInt8(5) * 256 + data.readUInt8(4);
      this.luxes.push(val);

      log.info(TAG, 'MEASURE: %s %d', name, val);
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
      if (err) {
        log.error(TAG, err);
      } else {
        log.info(TAG, 'cam saved: %s (%d)', filename, timestamp );
      }
      if (filename !== IMG_FILENAME)
        return;

      const status = `${this.netatmoStatus} ${this.braviaStatus}`;
      const data = fs.readFileSync(IMG_PATH);
      this.twitter.post('media/upload', {media: data}, (error, media) => {
        let media_ids;

        if (error)
          status += '📸 Cam error!';
        else
          media_ids = media.media_id_string;

        this._tweet(status, media_ids);
      });
      setTimeout(() => this.cam.start(), CAM_INTERVAL);
    });

    log.info(TAG, '=== Start ===');
    this.startNetatmoMonitor();
    this.startBraviaMonitor();
    this.cam.start();
  }

  startNetatmoMonitor () {
    this._getNetatomoStationData()
      .then(status => {
        this.netatmoStatus = status;
        setTimeout(() => {
          this.startNetatmoMonitor();
        }, NETATOMO_INTERVAL);
      });
  }

  startBraviaMonitor() {
    this._getBraviaStatus()
      .then(status => {
        status = '📺 ' + status;
        if (this.braviaStatus !== status ) {
          this.braviaStatus = status;
          this._tweet(`${this.netatmoStatus} ${this.braviaStatus}`);
        }

        setTimeout(() => {
          this.startBraviaMonitor();
        }, BRAVIA_INTERVAL);
      });
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

  _tweet(status, media_ids) {
    const st = {
      status: status + ' ⏰ ' + parseInt(_.now() / 1000) + 'UTC'
    };

    if (media_ids)
      st.media_ids = media_ids;

    this.twitter.post('statuses/update', st, (error) => {
      if(error)
        log.error(TAG, 'Error: %j', error);
      else
        log.info(TAG, 'POST: %j', st);
    });
  }

  _getNetatomoStationData () {
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

  _getBraviaStatus () {
    return this.bravia.system.invoke('getPowerStatus')
      .then(info => {
        if (info.status == 'active')  {
          return this.bravia.avContent.invoke('getPlayingContentInfo')
            .then(info => {
              let status = info.title;
              if (info.programTitle)
                status += ': ' + info.programTitle.replace(INVALID_TEXT_REGEXP, '');
              return status;
            });
        } else  {
          return Promise.resolve(info.status);
        }
      }).catch(err => {
        log.warn(TAG, 'Bravia err' + err);
        return '?';
      });
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
