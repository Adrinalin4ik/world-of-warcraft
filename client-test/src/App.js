import React from 'react';
import logo from './logo.svg';
import './App.css';
import geckos from '@geckos.io/client';

function App() {
  const channel = geckos({ port: 3001 }) // default port is 9208

  channel.onConnect(error => {
    if (error) {
      console.error(error.message)
      return
    }
  
    channel.on('chat message', data => {
      console.log(`You got the message ${data}`)
    });
  
    channel.emit('chat message', 'a short message sent to the server')
  });

  function click() {
    console.log('clicked')
    channel.emit('move', {
      x:1,
      y:1,
      z:1
    })
  }

  return (
    <div className="App">
      <header className="App-header" onClick={(e) => click()}>
        <img src={logo} className="App-logo" alt="logo"/>
        <p>
          Edit <code>src/App.js</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

export default App;
