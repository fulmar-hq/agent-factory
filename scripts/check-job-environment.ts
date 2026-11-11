import {join} from 'node:path';
import {homedir} from 'node:os';
import {root} from '../launcher/config';
import {checkInstalledEnvironments} from '../launcher/job-environment';
console.log(JSON.stringify(checkInstalledEnvironments(join(homedir(),'Library/LaunchAgents'),root)));
