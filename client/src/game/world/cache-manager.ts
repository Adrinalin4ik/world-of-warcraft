class CacheManager {

  constructor() {
    // Check for support.
    if (!('indexedDB' in window)) {
      console.log("This browser doesn't support IndexedDB.");
      return;
    }

    var db;
    var request = window.indexedDB.open("cache", 1);
    
    request.onerror = function(event) {
      console.log("error: ");
    };
    
    request.onsuccess = function(event) {
      db = request.result;
      console.log("success: "+ db);
      // var objectStore = db.createObjectStore("m2", {keyPath: "id"});
      console.log(db)
      // for (var i in employeeData) {
      //     objectStore.add(employeeData[i]);
      // }
    };
    
    request.onupgradeneeded = function(event) {
      debugger;
      // var db = event.result;
      // var objectStore = db.createObjectStore("m2", {keyPath: "id"});
      // // for (var i in employeeData) {
      // //     objectStore.add(employeeData[i]);
      // // }
    }
  }
}

export default new CacheManager();