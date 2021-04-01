# World-of-warcraft

Install StormLib and BLPConverter, which are using for handling Blizzard's game files.

### BPL converter
```bash
sudo apt-get install cmake git gcc g++
git clone git://github.com/Kanma/BLPConverter.git
cd BLPConverter
cmake CMakeLists.txt -DWITH_LIBRARY=YES
sudo make install
sudo ldconfig
```
### Storm lib
```bash
sudo apt-get install cmake git gcc zlib1g-dev python libbz2-dev
git clone git://github.com/ladislav-zezula/StormLib.git
cd StormLib
cmake CMakeLists.txt -DBUILD_SHARED_LIBS=ON
sudo make install
sudo ldconfig
```

```bash
#client
cd client 
npm install
npm run start

#server
cd ../server
npm install
npm run gulp
npm run serve
```
