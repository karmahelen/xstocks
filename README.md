# xstocks

xstocks is a personal stocks watchlist app built on the Hearth framework (https://github.com/karmahelen/hearth). It uses Finnhub for real-time quotes, news, and earnings + yfinance for historical chart data and fallback. Quotes data is stored in a SQLite database (xstocks.db) locally.

I got frustrated when the built-in stocks widget stopped working for me on my android phone so I decided to create something that I could have more control over.

Check out the "App Pics" below to see what it looks like and get a sense of what it can do.

The interesting thing that I tried to do with this is that since it is written in python/html/css/javascript, if you have any background with any of those you should be able to go make changes easily and see what happens instantly since you don't have to worry about compiling anything. Also, with the Hearth framework it is nice to be able to serve the app up to a port that can be accessed from any other computer on your network for flexibility. When I am not on my home network, I have my phone tailscale to my linux machine so I can access this app (in serve mode) on the go.

## Features
* (Need to Add)

I would definitely like to add more features based on feedback.

## Install
Run the following to install/update:

    curl -fsSL https://raw.githubusercontent.com/karmahelen/hearth/main/hearth-install.sh | bash

NOTE: The script will also install the necessary Hearth framework, but if you point it to a directory where it already exists then it will give you the option to just install/update xstocks.

(Need to add how to setup Finhubb API key)

## Uninstall
Everything is self-contained to the folder you install to so if you don't like it you can just delete the folder to remove/uninstall.

## App Pics
[![View App Pics](https://img.shields.io/badge/App-Pics-blue)](https://karmahelen.github.io/xstocks/AppPics.html)

## Background
I started development of this project for my own personal purposes on my Linux Mint. As I started building it up, I thought that this might be worthwhile to share. As a solo developer, I have currently only been able to fully test it out on Linux Mint 22.2 Cinnamon. I believe it should work with current releases of Ubuntu and potentially other similar Linux distros. If I can strike up interest, I would love to continue developing this for a broader audience but I need feedback. You can reach out to me at:

xstocks.helpless770@passinbox.com
(I am using an email alias for filtering purposes and this is what I was able to create)

I am still working on better documentation to describe the functionality and features but am waiting to see if there is any real interest before spending too much effort.

Thanks for taking the time to look at this and hopefully you found something of interest!

## License
GNU GPLv3

## Support My Work
This project is open-source and free to use. If it has brought you value please consider throwing a tip in my jar.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/karmahelen)
