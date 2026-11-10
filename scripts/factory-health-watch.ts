#!/usr/bin/env bun
import {root} from '../launcher/config';
import {mailPath} from '../launcher/alerts';
import {watchFactoryHealth,rehearseFactoryAlarm} from '../launcher/factory-health-runtime';
import {watchIdleQueue} from '../launcher/idle-queue';
const args=process.argv.slice(2);
if(args.length===0){
 try{console.log(JSON.stringify({idleQueue:watchIdleQueue(root,mailPath())}));}catch(error){console.error(JSON.stringify({idleQueueError:String(error)}));}
 console.log(JSON.stringify(await watchFactoryHealth(root,mailPath())));
}
else if(args.length===2&&args[0]==='--rehearse')console.log(JSON.stringify(rehearseFactoryAlarm(mailPath(),args[1]!)));
else throw Error('factory-health-watch [--rehearse YYYY-MM-DD]');
