class ArrayUtil {

  // Generates array from given hex string
  static fromHex(hex) {
    const array = [];
    for (let i = 0; i < hex.length; i += 2) {
      array.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return array;
  }

  static arrayMax( array ) {

    if ( array.length === 0 ) return - Infinity;
  
    var max = array[ 0 ];
  
    for ( var i = 1, l = array.length; i < l; ++ i ) {
  
      if ( array[ i ] > max ) max = array[ i ];
  
    }
  
    return max;
  }

}

export default ArrayUtil;
