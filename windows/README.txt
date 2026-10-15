AP Automation Agent for Infor SyteLine
=======================================

The agent lets AP Automation read purchase orders, receipts and vendors from
SyteLine, and (once you allow it) create vouchers, without opening your
network to the internet.

  - It makes one outbound HTTPS connection (port 443) to ap-automation.co.uk
    and keeps it open. No inbound firewall rules, port forwarding or VPN.
  - It reaches SyteLine through SyteLine's IDO web service (recommended), so
    SyteLine's own business rules and security apply, or reads straight from
    its SQL database.
  - The SyteLine user, SQL login and passwords stay in agent.env on this
    server. They are never sent to AP Automation.
  - It runs in the background as the Windows scheduled task
    "AP Automation Agent" (as SYSTEM, starting with Windows), and starts
    itself again if it ever stops.


What you need
-------------
  - Windows Server 2016 / Windows 10 or later, 64-bit. It need not be a
    SyteLine server: any server that can reach SyteLine and the internet will
    do.
  - That server can make outbound HTTPS connections to ap-automation.co.uk,
    directly or through a proxy.
  - The agent key, from AP Automation: Connectors > Infor SyteLine >
    Configure > On-site agent.
  - Through the IDO service: its address and a SyteLine user (see below).
    Or through SQL: a SQL Server login (see below).


Through the IDO service (recommended)
-------------------------------------
The IDO web service runs on the SyteLine web (utility) server, at
    http://<server>/IDORequestService/IDOWebService.asmx
Opening that address in a browser on this server shows "IDOWebService" if it
can be reached.

Create a SyteLine user for AP Automation (Users form):
  - license it for the SyteLineAutomation module (Modules), without which the
    IDO service refuses its sign-in;
  - give it access to vendors, purchase orders, PO lines and receipts, and,
    for posting, to Generate A/P Transactions;
  - note the configuration name it signs in to (as on the sign-in screen).


Through the SQL database (reading only)
---------------------------------------
Reading needs SELECT on five tables in the SyteLine application database.
Run in SQL Server Management Studio, with your own names and password:

    USE [master];
    CREATE LOGIN [ap_automation] WITH PASSWORD = 'choose-a-strong-password', CHECK_POLICY = ON;
    USE [YOUR_SL_APP_DB];
    CREATE USER [ap_automation] FOR LOGIN [ap_automation];
    GRANT SELECT ON dbo.vendor_mst   TO [ap_automation];
    GRANT SELECT ON dbo.vendaddr_mst TO [ap_automation];
    GRANT SELECT ON dbo.po_mst       TO [ap_automation];
    GRANT SELECT ON dbo.poitem_mst   TO [ap_automation];
    GRANT SELECT ON dbo.po_rcpt_mst  TO [ap_automation];

SQL Server must allow SQL Server logins ("SQL Server and Windows
Authentication mode"), or use a Windows account instead (the installer asks).
Vouchers are never written through SQL: only through the IDO service.


Install
-------
  1. Unzip this package anywhere on the server.
  2. Right-click install.cmd > Run as administrator.
  3. Enter the agent key, choose the IDO service or the SQL database, and
     enter its details when asked.
  4. It checks everything and lists anything to fix. When all checks pass it
     installs the agent and starts it.
  5. In AP Automation, Connectors > Infor SyteLine shows "Connected".
     Press Check SyteLine, then Sync.

Installed to: C:\Program Files\AP Automation Agent
  ap-automation-agent.exe   the agent
  agent.env                 its settings (administrators only)
  agent.env.example         every setting, explained
  logs\                     one log file per day, kept 14 days


Checking it
-----------
  Check the settings at any time (as administrator):
    "C:\Program Files\AP Automation Agent\ap-automation-agent.exe" --test

  Logs:  C:\Program Files\AP Automation Agent\logs
  Task:  Task Scheduler > Task Scheduler Library > AP Automation Agent

Common fixes
  - "The IDO service did not answer": check IDO_URL from a browser on this
    server; it ends in /IDORequestService/IDOWebService.asmx.
  - "SyteLine refused the sign-in": check IDO_USER, IDO_PASSWORD and
    IDO_CONFIG, and that the user is licensed for SyteLineAutomation.
  - Certificate errors on an https:// IDO address: the issuing certificate
    must be in the Windows certificate store, or set IDO_TLS_INSECURE=true.
  - "Could not reach SQL Server": check the name, that TCP/IP is enabled in
    SQL Server Configuration Manager, and the port (MSSQL_PORT). For a named
    instance the SQL Server Browser service must be running, or set the port.
  - TLS / SSL errors signing in to an older SQL Server (2012/2014): set
    MSSQL_LEGACY_TLS=true, or install SQL Server's TLS 1.2 update.
  - "Cannot reach ap-automation.co.uk": allow outbound HTTPS to it, or set
    PROXY_URL if the server uses a proxy.
  - Certificate errors through a proxy: set TLS_CA_FILE to the proxy's root
    certificate (Base-64 .cer/.pem). Certificates in the Windows store are
    already trusted.


Changing a setting
------------------
  1. Open Notepad as administrator, open ...\AP Automation Agent\agent.env.
  2. Change it and save. Put values containing # or spaces in 'quotes'.
  3. Task Scheduler > AP Automation Agent > End, then Run.
  4. Run the --test command above.

A new agent key from AP Automation (Replace key) disconnects the old one at
once: put the new key in AGENT_KEY and restart the task.


Updating
--------
Unzip the new package and run its install.cmd. The settings are kept. To
switch an existing install from SQL to the IDO service, add the IDO_ settings
from agent.env.example to agent.env and restart the task.


Removing
--------
Run uninstall.cmd (in the package, or in C:\Program Files\AP Automation Agent)
as administrator.
