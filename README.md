# FastProxy #
Быстрый http прокси, через который можно запускать автотесты или другую достаточно большую нагрузку. http запросы записываются в Mongo, после этого их можно импортировать в burp suite () или в какое-нибудь другое приложение

Перед первым запуском нужно установить зависимости и сгенерить корневой сертификат
```
npm install
./gen_ca.sh
```

## Тюнинг настроек linux ##
На своей виртуалке я выполнил следующие команды (взял в гугле, не уверен, что все полезны):
```
sudo sysctl net.ipv4.ip_local_port_range="15000 61000"
sudo sysctl net.ipv4.tcp_fin_timeout=15
sudo sysctl net.ipv4.tcp_tw_reuse=1
sudo sysctl net.core.somaxconn=8192
sudo ifconfig ens3 txqueuelen 5000
sudo sysctl net.core.netdev_max_backlog=8000
sudo sysctl net.ipv4.tcp_max_syn_backlog=8192
ulimit -n 65535
```