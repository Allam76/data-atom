"use babel";

import fs from 'fs';
import DataAtomView from './views/data-atom-view';
import DataDetailsView from './views/data-details-view';
import NewConnectionDialog from './views/new-connection-dialog';
import DbFactory from './data-managers/db-factory';
import URL from 'url';

function elapsedTime(start) {
  var precision = 2; // 3 decimal places
  var elapsed = (process.hrtime(start)[0] * 1000) + (process.hrtime(start)[1] / 1000000); // divide by a million to get nano to milli
  elapsed = elapsed.toFixed(precision);
  return elapsed >= 10000 ? (elapsed/1000).toFixed(precision) + ' s' : elapsed + ' ms';
}

/*
  The main entry and controller for Data Atom.
  - A single DataAtomView is used, shown or hidden based on the state of a editor
  - Each file gets an object holding state against it, we tell the view to render that. State is height, results, selected connection/db, etc.
  - This gives the feeling that each editor has their view  but we only have 1 view and many states
  Not sure yet if it'll be quicker/better swaping out the whole view at an element or this way
*/
export default class DataAtomController {
  constructor(serializeState, statusBarManager) {
    // Holds a mapping from editor ID to the DataResultView and some options for that editor view
    this.viewStateToEditor = {};
    this.connectionList = {};
    this.statusBarManager = statusBarManager;

    this.mainView = new DataAtomView();
    this.detailsView = new DataDetailsView();
    this.mainView.onConnectionChanged(() => this.onConnectionChanged());
    this.mainView.onDatabaseChanged(() => this.onDatabaseChanged());
    this.mainView.onQueryCancel(() => this.onQueryCancel());
    this.mainView.onDisconnect(() => this.onDisconnect());
    atom.commands.add('atom-workspace', 'data-atom:new-connection', () => this.createNewConnection());
    atom.commands.add('atom-workspace', 'data-atom:new-query', () => this.newQuery());
    atom.commands.add('atom-workspace', 'data-atom:execute', () => this.execute());
    atom.commands.add('atom-workspace', 'data-atom:execute Current Paragraph', () => {
      editor = atom.workspace.getActiveTextEditor();
      editor.moveToBeginningOfNextParagraph();
      editor.selectToBeginningOfPreviousParagraph();
      this.execute();
    });
    atom.commands.add('atom-workspace', 'data-atom:toggle-results-view', () => this.toggleMainView());
    atom.commands.add('atom-workspace', 'data-atom:toggle-details-view', () => this.toggleDetailsView());
    atom.commands.add('atom-workspace', 'data-atom:toggle-query-source', () => this.toggleQuerySource());
    atom.commands.add('atom-workspace', 'data-atom:edit-connections', () => this.editConnections());
    atom.commands.add('atom-workspace', 'data-atom:query-table', (el) => this.queryTable(el));
    atom.commands.add('atom-workspace', 'data-atom:copy-to-editor', (el) => this.copyToEditor(el));
    atom.commands.add('atom-workspace', 'data-atom:copy-from-editor', (el) => this.copyFromEditor(el));
    atom.workspace.onDidChangeActivePaneItem(() => this.onActivePaneChanged());
    atom.workspace.onDidDestroyPaneItem((e) => {
      if (e.item && e.item.id && this.viewStateToEditor[e.item.id])
        delete this.viewStateToEditor[e.item.id];
    });
  }
  // show the results view for the selected editor
  onActivePaneChanged() {
    this.mainView.hide();
    this.detailsView.hide();
    var editor = atom.workspace.getActiveTextEditor();
    if (editor && editor.id) {
      // do not trigger creation of state - defer until we need to show it
      if (this.viewStateToEditor[editor.id]) {
        var currentViewState = this.getOrCreateCurrentResultView();
        if (currentViewState) {
          if (currentViewState.isMainViewShowing)
            this.showMainView(false);
          if (currentViewState.isDetailsViewShowing)
            this.showDetailsView();
        }
      }
    }
  }

  destroy() {
  }

  serialize() {}

  isEditorNotActive() {
    return atom.workspace.getActiveTextEditor() === undefined;
  }

  // Gets or creates the ResultView state for the current editor
  // Assumes it is being called in a state where there is an active editor
  getOrCreateCurrentResultView() {
    var editor = atom.workspace.getActiveTextEditor();

    if (editor && !this.viewStateToEditor[editor.id]) {
      this.viewStateToEditor[editor.id] = {
        results: [], // no results yet
        isMainViewShowing: false,
        isDetailsViewShowing: false,
        connectionName: null,
        database: null,
        useEditorAsQuery: (/p?sql$/).test(editor.getTitle()) || editor.getGrammar().name == 'SQL' ? true : false,
        useQueryAtCursor: atom.config.get('data-atom.useQueryAtCursor')
      };
    }

    return this.viewStateToEditor[editor.id];
  }

  getDataManager(connectionName) {
    return this.connectionList[connectionName];
  }

  showMainView(withDetailsViewCheck = true) {
    if (this.isEditorNotActive())
      return;

    var currentViewState = this.getOrCreateCurrentResultView();
    if (currentViewState.error)
      this.mainView.setMessage(currentViewState.error);
    else
      this.mainView.setResults(currentViewState.results);
    // set the selected connection/db too
    var dataManager = this.getDataManager(currentViewState.connectionName);
    if (dataManager) {
      dataManager.getDatabaseNames().then(names => this.mainView.setState(currentViewState.connectionName, names, currentViewState.database, currentViewState.useEditorAsQuery));
    }
    else {
      this.mainView.setState('0', [], '', currentViewState.useEditorAsQuery);
    }
    this.mainView.show();
    currentViewState.isMainViewShowing = true;
    // if they toggle the details closed but have the results open, we don't want to open it again on active tab changes
    if (withDetailsViewCheck && atom.config.get('data-atom.openDetailsViewWhenOpeningMainResultsView'))
      this.showDetailsView();
  }

  toggleMainView() {
    if (this.isEditorNotActive())
      return;

    var currentState = this.getOrCreateCurrentResultView();
    if (this.mainView.isShowing) {
      this.mainView.hide();
      if (atom.config.get('data-atom.openDetailsViewWhenOpeningMainResultsView')) {
        this.detailsView.hide();
        currentState.isDetailsViewShowing = this.detailsView.isShowing;
      }
    }
    else
      this.showMainView();
    currentState.isMainViewShowing = this.mainView.isShowing;
  }

  toggleQuerySource() {
    if (this.isEditorNotActive())
      return;

    var currentState = this.getOrCreateCurrentResultView();
    currentState.useEditorAsQuery = !currentState.useEditorAsQuery;
    if (this.mainView.isShowing)
      this.mainView.useEditorAsQuerySource(currentState.useEditorAsQuery);
  }

  showDetailsView() {
    var currentViewState = this.getOrCreateCurrentResultView();
    var dataManager = this.getDataManager(currentViewState.connectionName);
    if (dataManager)
      this.detailsView.setDbManager(dataManager);
    else
      this.detailsView.clearDbManager();
    this.detailsView.show();
    currentViewState.isDetailsViewShowing = true;
  }

  toggleDetailsView() {
    if (this.isEditorNotActive())
      return;

    var currentState = this.getOrCreateCurrentResultView();
    if(this.detailsView.isShowing)
      this.detailsView.hide();
    else
      this.showDetailsView();
    currentState.isDetailsViewShowing = this.detailsView.isShowing;
  }

  /**
   * Called when the user changes the connection (or database)
   */
  onConnectionChanged() {
    var selectedName = this.mainView.getSelectedConnection();
    var newManager = this.getDataManager(selectedName);
    if (!newManager) {
      //this.mainView.clearDatabaseSelection();
      this.detailsView.clearDbManager();
    }
    else {
      this.detailsView.setDbManager(newManager);
      var currentViewState = this.getOrCreateCurrentResultView();
      currentViewState.connectionName = selectedName;
      currentViewState.database = null;
      newManager.getDatabaseNames().then(names => this.mainView.setDatabaseSelection(names, currentViewState.database));
    }
  }

  onDatabaseChanged() {
    var selectedDatabase = this.mainView.getSelectedDatabase();
    var currentViewState = this.getOrCreateCurrentResultView();
    currentViewState.database = selectedDatabase;

    var newManager = this.getDataManager(this.mainView.getSelectedConnection());
    this.setupAutocomplete(currentViewState.database, newManager);
  }

  onQueryCancel() {
    var currentState = this.getOrCreateCurrentResultView();
    if (currentState.queryToken) {
      var dbManager = this.getDataManager(currentState.connectionName);
      dbManager.cancelExecution(currentState.queryToken);
      currentState.queryToken = null;
    }
  }

  onDisconnect() {
    var currentViewState = this.getOrCreateCurrentResultView();
    var disconnectingDataManager = this.getDataManager(currentViewState.connectionName);
    // Each view has their own DataManager, 'close' this view's
    if (disconnectingDataManager) {
      delete this.connectionList[disconnectingDataManager.getConnectionName()];
      disconnectingDataManager.destroy();
    }
    currentViewState.database = null;
    currentViewState.connectionName = null;
  }

  createNewConnection(thenDo) {
    if (this.isEditorNotActive())
      return;

    // prompt for a connection
    var newConnectionDialog = new NewConnectionDialog( (url, connectionName) => {
      var dbManager = DbFactory.createDataManagerForUrl(url, connectionName);
      if (dbManager === null) {
        atom.notifications.addInfo(`Sorry the protocol '${URL.parse(url).protocol}' does not map to a supported DB.`);
      }
      else {
        var currentState = this.getOrCreateCurrentResultView();
        // set the view for the connection, db names will come next
        this.mainView.setState(dbManager.getConnectionName(), [], null, currentState.useEditorAsQuery);

        if (this.connectionList[dbManager.getConnectionName()]) {
          // don't duplicate connection, just select the connection
          dbManager.getDatabaseNames().then(names => this.mainView.setState(dbManager.getConnectionName(), names, currentState.database, currentState.useEditorAsQuery));
        }
        else {
          this.connectionList[dbManager.getConnectionName()] = dbManager;

          this.mainView.addConnection(dbManager.getConnectionName());
          dbManager.getDatabaseNames().then(names => this.mainView.setState(dbManager.getConnectionName(), names, currentState.database, currentState.useEditorAsQuery));

          this.detailsView.setDbManager(dbManager);
        }
        currentState.database = dbManager.defaultDatabase;
        currentState.connectionName = dbManager.getConnectionName();
        this.setupAutocomplete(currentState.database, dbManager);
        if (thenDo)
          thenDo();
      }
    });
    newConnectionDialog.show();
  }

  setupAutocomplete(database, dbManager) {
    var editor = atom.workspace.getActiveTextEditor();
    if (dbManager) {
      editor.dataAtomTables = null;
      editor.dataAtomColumns = null;
      editor.dataAtomSchemata = null;
      editor.defaultSchema = dbManager.getDefaultSchema();
      dbManager.getSchemaNames(database).then(schemata => {
        editor.dataAtomSchemata = schemata;
      }).catch(err => {
        this.mainView.setMessage(err);
      });
      dbManager.getTables(database).then(tables => {
        editor.dataAtomTables = tables;

        dbManager.getTableDetails(database, tables).then(details => {
          editor.dataAtomColumns = details;
        });
      }).catch(err => {
        this.mainView.setMessage(err);
      });
    }
  }

  refreshMetaData(database, dbManager) {
    this.setupAutocomplete(database, dbManager)
  }

  newQuery() {
    if (this.isEditorNotActive())
      return;

    if (!this.mainView.isShowing)
      this.showMainView();
    this.getOrCreateCurrentResultView().useEditorAsQuery = false;
    this.mainView.useEditorAsQuerySource(false);
    this.mainView.focusQueryInput();
    this.mainView.show();
  }

  /**
   * Save connections feature
   */
  editConnections() {
    fs.exists(DbFactory.file(), (exists) => {
      if (exists) {
        atom.workspace.open(DbFactory.file());
      } else {
        DbFactory.writeFile([]);
        atom.workspace.open(DbFactory.file());
      }
    });
  }

  /**
   * Query table
   */
  queryTable(el) {
    if (this.isEditorNotActive())
      return;

    if (!this.mainView.isShowing)
      this.showMainView();

    var currentViewState = this.getOrCreateCurrentResultView();
    var query = this.getDataManager(currentViewState.connectionName).getTableQuery(el.target.innerText);

    this.getOrCreateCurrentResultView().useEditorAsQuery = false;
    this.mainView.useEditorAsQuerySource(false);
    this.mainView.focusQueryInput();
    this.mainView.setQuery(query);

    this.actuallyExecute(currentViewState, query);
  }
  copyToEditor(el) {
    let editor = atom.workspace.getActiveTextEditor();
    editor.setText(el.target.textContent);
    editor.save();
  }
  copyFromEditor(el) {
    let editor = atom.workspace.getActiveTextEditor();
    var currentViewState = this.getOrCreateCurrentResultView();
    var idIndex = currentViewState.results[0].fields.findIndex((item)=>item.name == "id");
    if(idIndex === -1){
      this.mainView.setMessage("id column not in selection query, must be there to identify target row");
    } else {
      var comps = el.target.id.split(":");
      var queryComps = currentViewState.queryToken.query.text.split(" ");
      var tableName = queryComps[queryComps.indexOf("from") + 1].replace(";","");
      var resultRow = currentViewState.results[0].rows[comps[1]];
      var data = editor.getText();
      var queryText = `UPDATE ${tableName} SET ${comps[0]} = '${data}' WHERE id = '${resultRow[idIndex]}';`
      let dbManager = this.getDataManager(currentViewState.connectionName);

      this.mainView.executionBegin();
      dbManager.execute(currentViewState.database, queryText).then((res)=>{
        this.execute();
      }).catch((error)=>{
        this.mainView.setMessage(error);
      })

      this.mainView.executionEnd();
    }
  }

  /**
   * The Execute command. If no current connections it will prompt for a connect and then execute. Otherwise it'll execute the statement(s) on the current connection
   */
  execute() {
    if (this.isEditorNotActive())
      return;

    var currentViewState = this.getOrCreateCurrentResultView();
    // the toggle in the main view tells us where to get the query from
    var query = this.mainView.getQuery(currentViewState.useEditorAsQuery, currentViewState.useQueryAtCursor);
    if (!currentViewState || !currentViewState.connectionName) {
      this.createNewConnection(() => {
        this.actuallyExecute(currentViewState, query);
      });
    }
    else {
      if (!currentViewState.database) {
        console.warn('no database selected in currentViewState')
        // todo message to select a DB
      }
      else {
        this.actuallyExecute(currentViewState, query);
      }
    }
  }

  actuallyExecute(executingViewState, query) {
    this.mainView.executionBegin();
    executingViewState.results = [];
    executingViewState.error = null;
    // make sure it's showing the results view with cleared results
    this.showMainView();

    var start = process.hrtime();
    var seconds = 0;
    this.statusBarManager.update('executing', seconds + ' s');
    var executingTimer = setInterval(() => this.statusBarManager.update('executing', (++seconds) + ' s'), 1000);

    let dbManager = this.getDataManager(executingViewState.connectionName);
    dbManager.execute(executingViewState.database, query,
      queryToken => { executingViewState.queryToken = queryToken; })
    .then(results => {
      let requiresMetaRefresh = results.map(i => {
        if (i.command !== undefined && (i.command === 'CREATE' || i.command === 'ALTER' || i.command === 'DROP'))
          return true;
        return false;
      }).filter(i => i == true);
      if (requiresMetaRefresh.length > 0)
        this.refreshMetaData(executingViewState.database, dbManager);

      this.updateStatusBar(executingTimer, start);
      executingViewState.results = results;
      this.mainView.setResults(results);
      this.mainView.executionEnd();
    })
    .catch(err => {
      this.updateStatusBar(executingTimer, start);
      executingViewState.error = err;
      this.mainView.setMessage(err);
      this.mainView.executionEnd();
    });
  }

  // private
  updateStatusBar(executingTimer, start) {
    clearInterval(executingTimer);
    var elapsed = elapsedTime(start);
    this.statusBarManager.update('completed', elapsed);
  }
}
