import os from 'os';

export default [
  {
    type: 'input',
    name: 'serverPort',
    message: 'Server port',
    default: '3000'
  },
  {
    type: 'input',
    name: 'clusterWorkerCount',
    message: 'Number of cluster workers',
    default: Math.ceil(os.cpus().length / 2)
  }
];
