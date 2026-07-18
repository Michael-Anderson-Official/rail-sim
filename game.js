/* =========================================================================
   Rail Sim — 桜上水〜上北沢（京王線 実データ）ブラウザ3D 第1スライス
   ・実際の線路カーブ（OSM）を3Dで敷設
   ・桜上水を2面4線（本線±通過線＋待避線の passing loop）で表現
   ・特急が本線を通過する間、各停が待避線で待つ「待避」を再現（今回は台本制御）
   ========================================================================= */
(function () {
  'use strict';

  // 京王の車両形式（実車の帯色・塗装をもとにした低ポリ表現）。makeTrain()より先に定義する必要がある。
  // 車体はローカルZが進行方向（前面は+Z端）、幅はX、高さはY。
  var TRAIN_TYPES = {
    // 5000系：京王ライナー。銀車体に赤〜紺のラッピング、黒い前面
    KEIO_5000: { base: 0xe0e4e9, roof: 0xbabec4, front: 0x1b1f2a, name: '5000系',
      bands: [{ y: 1.35, h: 0.55, color: 0xd6006f }, { y: 0.82, h: 0.5, color: 0x16295c }], accent: 0xd6006f },
    // 8000系：ステンレス銀に京王ブルーの帯＋細い赤ライン
    KEIO_8000: { base: 0xd2d6db, roof: 0xaeb2b8, front: 0x222732, name: '8000系',
      bands: [{ y: 2.15, h: 0.5, color: 0x0e4aa0 }, { y: 2.5, h: 0.12, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 7000系：ステンレス銀に青帯＋赤ライン（帯の位置を8000と少し変える）
    KEIO_7000: { base: 0xd4d8dd, roof: 0xafb3b9, front: 0x242934, name: '7000系',
      bands: [{ y: 2.2, h: 0.45, color: 0x0e4aa0 }, { y: 1.85, h: 0.12, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 9000系：ステンレス銀に青＋赤帯、前面は黒い顔
    KEIO_9000: { base: 0xd8dce1, roof: 0xb2b6bc, front: 0x141821, name: '9000系',
      bands: [{ y: 2.15, h: 0.5, color: 0x0e4aa0 }, { y: 2.5, h: 0.14, color: 0xe4007f }], accent: 0x0e4aa0 },
    // 2000系：往年のライトグリーン塗装（レトロ）
    KEIO_2000: { base: 0x86b96a, roof: 0x6f9e57, front: 0x5f8a49, name: '2000系',
      bands: [{ y: 2.55, h: 0.16, color: 0xece5cc }], accent: 0xece5cc }
  };

  // ---- 実地形（国土地理院DEM5A・5mメッシュLiDAR）。シーンのy=0は区間中心の実標高に合わせる ----
  var TERRAIN_BASE = (function () {
    if (typeof TERRAIN === 'undefined') return 0;
    var i0 = Math.max(0, Math.min(TERRAIN.cols - 1, Math.round((0 - TERRAIN.ox) / TERRAIN.cell)));
    var j0 = Math.max(0, Math.min(TERRAIN.rows - 1, Math.round((0 - TERRAIN.oz) / TERRAIN.cell)));
    return TERRAIN.h[j0 * TERRAIN.cols + i0];
  })();
  function terrainHeight(x, z) {
    if (typeof TERRAIN === 'undefined') return 0;
    var fx = (x - TERRAIN.ox) / TERRAIN.cell, fz = (z - TERRAIN.oz) / TERRAIN.cell;
    var i0 = Math.max(0, Math.min(TERRAIN.cols - 2, Math.floor(fx)));
    var j0 = Math.max(0, Math.min(TERRAIN.rows - 2, Math.floor(fz)));
    var dx = Math.max(0, Math.min(1, fx - i0)), dz = Math.max(0, Math.min(1, fz - j0));
    var h00 = TERRAIN.h[j0 * TERRAIN.cols + i0], h10 = TERRAIN.h[j0 * TERRAIN.cols + i0 + 1];
    var h01 = TERRAIN.h[(j0 + 1) * TERRAIN.cols + i0], h11 = TERRAIN.h[(j0 + 1) * TERRAIN.cols + i0 + 1];
    var top = h00 * (1 - dx) + h10 * dx, bot = h01 * (1 - dx) + h11 * dx;
    return (top * (1 - dz) + bot * dz) - TERRAIN_BASE;
  }

  // ---- シーンの基本 ----
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd4e6);
  scene.fog = new THREE.Fog(0xbcd4e6, 700, 1900);   // 3.2km区間: 引きでも駅2〜3個ぶん見える距離

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById('app').appendChild(renderer.domElement);

  var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 4000);
  camera.position.set(120, 180, 320);

  // 地図アプリ流の操作（1本指=移動、2本指=回転・ズーム）。回転主体のOrbitからMapControlsへ変更
  var controls = new THREE.MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;       // パンは地面に沿って滑る
  controls.maxPolarAngle = Math.PI * 0.47;   // 地面より下に回り込まない
  controls.minDistance = 25;
  controls.maxDistance = 1700;
  controls.zoomSpeed = 1.15;

  // ---- ライティング ----
  var hemi = new THREE.HemisphereLight(0xffffff, 0x788c78, 0.85);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xfff4e0, 0.9);
  sun.position.set(-260, 380, 220);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  var sc = sun.shadow.camera;
  sc.left = -1500; sc.right = 1500; sc.top = 550; sc.bottom = -550; sc.near = 1; sc.far = 1600;
  scene.add(sun);

  // ---- 地面（実標高で起伏化。国土地理院DEM5Aの実測値をそのまま頂点変位） ----
  var ground = buildTerrainGround();
  var osmMesh = buildRealBuildings();   // OSM箱建物（PLATEAU読込完了までのつなぎ＆フォールバック）
  buildRoads();                         // OSM実道路（甲州街道〜生活道路・歩道）
  loadPlateau();                        // PLATEAU LOD2（実際の屋根形状の建物）を非同期で読み込む

  // ---- 地面メッシュ：TERRAINグリッドと同じ格子で頂点変位（実際の起伏をそのまま形状に） ----
  function buildTerrainGround() {
    var W = 4200, H = 2400, res = (typeof TERRAIN !== 'undefined') ? TERRAIN.cell : 15;
    var cols = Math.round(W / res), rows = Math.round(H / res);
    var pos = [], idx = [];
    for (var j = 0; j <= rows; j++) {
      for (var i = 0; i <= cols; i++) {
        var x = -W / 2 + i * res, z = -H / 2 + j * res;
        pos.push(x, terrainHeight(x, z), z);
      }
    }
    var stride = cols + 1;
    for (var j2 = 0; j2 < rows; j2++) {
      for (var i2 = 0; i2 < cols; i2++) {
        var a = j2 * stride + i2, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, c, b, c, d, b);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    var mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x9bb08a }));
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // ---- 実在道路（roads.js: OSM highwayのポリライン）を帯メッシュ化 ----
  function buildRoads() {
    if (typeof ROADS === 'undefined') return;
    var geos = [null, null];                                  // k=0 車道 / k=1 歩道系
    var pos = [[], []], idx = [[], []];
    for (var r = 0; r < ROADS.length; r++) {
      var rd = ROADS[r], pts = rd.p, hw = rd.w / 2, k = rd.k;
      var P = pos[k], I = idx[k];
      for (var i = 0; i < pts.length; i++) {
        // 各頂点の進行方向（前後セグメントの平均）に対する法線でオフセット
        var p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
        var dx = p1[0] - p0[0], dz = p1[1] - p0[1];
        var L = Math.sqrt(dx * dx + dz * dz) || 1;
        var nx = -dz / L, nz = dx / L;
        var base = P.length / 3;
        var ry = terrainHeight(pts[i][0], pts[i][1]);
        P.push(pts[i][0] + nx * hw, ry, pts[i][1] + nz * hw,
               pts[i][0] - nx * hw, ry, pts[i][1] - nz * hw);
        if (i > 0) I.push(base - 2, base - 1, base, base - 1, base + 1, base);
      }
    }
    var mats = [
      new THREE.MeshLambertMaterial({ color: 0x62666e, polygonOffset: true, polygonOffsetFactor: -2 }),
      new THREE.MeshLambertMaterial({ color: 0x9a9c96, polygonOffset: true, polygonOffsetFactor: -1 })
    ];
    for (var k2 = 0; k2 < 2; k2++) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos[k2], 3));
      g.setIndex(idx[k2]);
      g.computeVertexNormals();
      var mesh = new THREE.Mesh(g, mats[k2]);
      mesh.position.y = -0.02 + k2 * 0.005;   // 地面-0.05とバラスト0.02の間（踏切は道路がレール下に潜る見え方）
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // ---- PLATEAU LOD2建物の読み込み（b3dm→glb化済み・Draco圧縮） ----
  function loadPlateau() {
    if (typeof PLATEAU_TILES === 'undefined' || typeof fetch === 'undefined' ||
        !THREE.GLTFLoader || !THREE.DRACOLoader) return;
    var draco = new THREE.DRACOLoader();
    draco.setDecoderPath('draco/');
    var loader = new THREE.GLTFLoader();
    loader.setDRACOLoader(draco);

    // ECEF→ローカル(ENU)変換の基底（SEGMENT.centerを原点に）
    var A = 6378137, E2 = 0.00669437999014;
    var la = SEGMENT.center.lat * Math.PI / 180, lo = SEGMENT.center.lng * Math.PI / 180;
    var Nrad = A / Math.sqrt(1 - E2 * Math.sin(la) * Math.sin(la));
    var C0 = [Nrad * Math.cos(la) * Math.cos(lo), Nrad * Math.cos(la) * Math.sin(lo), Nrad * (1 - E2) * Math.sin(la)];
    var Ev = [-Math.sin(lo), Math.cos(lo), 0];
    var Nv = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    var Uv = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    // ecefベクトル→three(x=東, y=上, z=南)への回転行列
    var Menu = new THREE.Matrix4().set(
      Ev[0], Ev[1], Ev[2], 0,
      Uv[0], Uv[1], Uv[2], 0,
      -Nv[0], -Nv[1], -Nv[2], 0,
      0, 0, 0, 1);
    var RxB = new THREE.Matrix4().makeRotationX(Math.PI / 2);   // glTF y-up → ECEF z-up（規格どおりの向き）

    function tileMatrix(centerEcef, useRx) {
      var d = new THREE.Vector3(centerEcef[0] - C0[0], centerEcef[1] - C0[1], centerEcef[2] - C0[2]);
      d.applyMatrix4(Menu);
      var rot = new THREE.Matrix4().copy(Menu);
      if (useRx) rot.multiply(RxB);
      var m = new THREE.Matrix4().copy(rot);
      m.setPosition(d);
      return m;
    }

    var group = new THREE.Group();
    var pmat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // 壁と屋根のパレット（建物IDで1軒ずつ色を変える）
    var WALLS = [[0.93, 0.91, 0.86], [0.88, 0.86, 0.82], [0.92, 0.92, 0.92], [0.86, 0.82, 0.75], [0.90, 0.87, 0.80], [0.84, 0.86, 0.88], [0.95, 0.93, 0.88]];
    var ROOFS = [[0.42, 0.45, 0.50], [0.52, 0.38, 0.33], [0.38, 0.42, 0.38], [0.45, 0.45, 0.47], [0.55, 0.48, 0.40], [0.35, 0.38, 0.45]];
    // 線路中心線のサンプル点（8m刻み）。線路帯に重なるPLATEAU建物（実在の駅ホーム等）の除去に使う
    var trackPts = [];
    (function () {
      var P = SEGMENT.points;
      for (var i = 1; i < P.length; i++) {
        var a = P[i - 1], b = P[i];
        var d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var n = Math.max(1, Math.ceil(d / 8));
        for (var k = 0; k < n; k++) trackPts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      }
    })();

    // 屋根/壁の塗り分け＋線路帯の建物除去
    function paintTile(node, rotMatrix, worldMatrix) {
      var inv = new THREE.Matrix4().copy(worldMatrix).invert();
      var sink = new THREE.Vector3(0, -500, 0).applyMatrix4(inv);   // 「消す」＝この1点に潰す
      var tmpV = new THREE.Vector3();
      node.traverse(function (o) {
        if (!o.isMesh) return;
        var g = o.geometry, pos = g.attributes.position, bid = g.getAttribute('_batchid');
        if (!bid) return;
        var sums = {}, n = pos.count;
        for (var i = 0; i < n; i++) {
          tmpV.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(worldMatrix);
          var id = bid.getX(i) | 0;
          var s = sums[id] || (sums[id] = [0, 0, 0]);
          s[0] += tmpV.x; s[1] += tmpV.z; s[2]++;
        }
        var hidden = {};
        // 線路帯(中心線8m以内)の実在構造物は駅舎含め全区間で除去（前面展望を優先。v16の駅周辺例外は撤廃）
        for (var idk in sums) {
          var s2 = sums[idk], cx = s2[0] / s2[2], cz = s2[1] / s2[2];
          for (var p = 0; p < trackPts.length; p++) {
            var dx = cx - trackPts[p][0], dz = cz - trackPts[p][1];
            if (dx * dx + dz * dz < 64) { hidden[idk] = 1; break; }
          }
        }
        for (var j = 0; j < n; j++) {
          if (hidden[bid.getX(j) | 0]) pos.setXYZ(j, sink.x, sink.y, sink.z);
        }
        pos.needsUpdate = true;
      });
      paintColors(node, rotMatrix);
    }
    function paintColors(node, rotMatrix) {
      var e = rotMatrix.elements;
      var ux = e[1], uy = e[5], uz = e[9];   // モデル空間での「上」ベクトル（回転行列の2行目）
      node.traverse(function (o) {
        if (!o.isMesh) return;
        var g = o.geometry;
        if (!g.attributes.normal) g.computeVertexNormals();
        var nor = g.attributes.normal, n = g.attributes.position.count;
        var bid = g.getAttribute('_batchid');
        var col = new Float32Array(n * 3);
        for (var i = 0; i < n; i++) {
          var d = nor.getX(i) * ux + nor.getY(i) * uy + nor.getZ(i) * uz;
          var id = bid ? (bid.getX(i) | 0) : 0;
          var pal, c;
          if (d > 0.55) { pal = ROOFS; c = pal[(id * 2654435761 >>> 0) % pal.length]; }
          else if (d < -0.5) { c = [0.30, 0.30, 0.32]; }
          else { pal = WALLS; c = pal[(id * 40503 >>> 0) % pal.length]; }
          col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        o.material = pmat;
        o.castShadow = false; o.receiveShadow = true;
      });
    }
    var loaded = 0, failed = 0;
    // 軸の向きはDracoを実デコードして検証済み：glTF y-up → ECEF z-up の Rx(+90°) が正
    // （node側の検証で up=80..98m ＝標高＋ジオイド＋建物高と一致することを確認）
    PLATEAU_TILES.forEach(function (t) {
      fetch('plateau/' + t.f).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        loader.parse(ab, '', function (g) {
          var node = g.scene;
          var m = tileMatrix(t.c, true);
          // タイル固有の地面高(t.g、Draco実デコードで事前計算済み)でいったん正規化してから、
          // 区間共通のterrainHeight(GSI DEM実測)に接地させる（タイル間の実際の起伏を復元）
          var tileGroundY = terrainHeight(m.elements[12], m.elements[14]);
          var M2 = new THREE.Matrix4().makeTranslation(0, tileGroundY - (t.g || 80), 0).multiply(m);
          paintTile(node, m, M2);   // 線路帯の実在駅構造物を除去＋屋根/壁/建物ごとの塗り分け
          var holder = new THREE.Group();
          holder.matrixAutoUpdate = false;
          holder.matrix.copy(M2);
          holder.add(node);
          group.add(holder);
          done();
        }, function () { failed++; done(); });
      }).catch(function () { failed++; done(); });
    });
    function done() {
      loaded++;
      if (loaded < PLATEAU_TILES.length) return;
      if (group.children.length === 0) return;         // 全滅ならOSM箱のまま
      // 接地はタイルごとにholder側で済ませてある
      scene.add(group);
      if (osmMesh) { scene.remove(osmMesh); }          // 箱の街からPLATEAUの街へ差し替え
    }
  }

  // ---- 中心線（実カーブ）をスプライン化 ----
  // SEGMENT.points は [x(east), z(south)] のメートル。three.jsは (x, y, z)。
  var centerPts = SEGMENT.points.map(function (p) { return new THREE.Vector3(p[0], 0, p[1]); });
  var center = new THREE.CatmullRomCurve3(centerPts, false, 'catmullrom', 0.5);
  var stA = SEGMENT.stations.sakurajosui;   // 桜上水
  var stB = SEGMENT.stations.kamikitazawa;  // 上北沢
  var stC = SEGMENT.stations.shimotakaido;  // 下高井戸（東端側）
  var stD = SEGMENT.stations.hachimanyama;  // 八幡山（西端側）
  var pSakura = new THREE.Vector3(stA[0], 0, stA[1]);

  // 中心線上で各駅に一番近いパラメータ u を求める
  var uSakura = nearestU(center, pSakura);
  var uKami = nearestU(center, new THREE.Vector3(stB[0], 0, stB[1]));   // 上北沢（島式1面2線）
  var uShimo = nearestU(center, new THREE.Vector3(stC[0], 0, stC[1]));  // 下高井戸（相対式2面2線）
  var uHachi = nearestU(center, new THREE.Vector3(stD[0], 0, stD[1]));  // 八幡山（2面4線・待避可）
  var LEN = center.getLength();
  var WINDOW = 150 / LEN;                    // 待避線が枝分かれする窓（±150m）

  // ---- 縦断勾配プロファイル：地上区間は実地形をなだらかに均した勾配、八幡山側は実際に高架化済み ----
  // 上北沢の207m先(八幡山の488m手前)から先が高架(OSM bridge=viaduct実測、京王電鉄「笹塚駅～仙川駅間
  // 連続立体交差事業」の既完成区間)。ランプで持ち上がった後は区間西端まで高架のまま続く。
  // OSMのbridgeタグは構造物として橋になった位置の実測で、ランプはその手前の土盛り区間にあたるため、
  // 上北沢のホーム端(建築限界+余裕)より後ろで、勾配が急になりすぎない長さを確保して開始位置を決める
  var U_TAG_FULL_HEIGHT = Math.min(1, 2270 / LEN);          // OSM実測: この位置には橋として存在
  var U_KAMI_PLATFORM_END = Math.min(1, uKami + 130 / LEN); // 上北沢ホーム端(105m)+余裕
  var RAMP_LEN = 300;                                        // 目標ランプ長(八幡山までの平坦デッキに余裕があるため長めに取り勾配を抑える)
  var U_RAMP_END = Math.max(U_TAG_FULL_HEIGHT, U_KAMI_PLATFORM_END + RAMP_LEN / LEN);
  var U_RAMP_START = Math.max(U_KAMI_PLATFORM_END, U_RAMP_END - RAMP_LEN / LEN);
  var VIADUCT_CLEARANCE = 6.5;                              // 高架下に道路が通れる桁下有効高の目安

  // 中心線沿いの実標高を20m間隔でサンプルし、移動平均(片側300m窓)でならして
  // 「鉄道として敷設可能ななだらかな縦断勾配」に近似する(生の地形そのままだと凹凸が急すぎる)
  var groundProfile = (function () {
    var STEP = 20, n = Math.max(2, Math.round(LEN / STEP));
    var raw = [];
    for (var i = 0; i <= n; i++) {
      var u = i / n, p = center.getPointAt(u);
      raw.push(terrainHeight(p.x, p.z));
    }
    var win = 15, sm = new Array(raw.length);
    for (var i2 = 0; i2 < raw.length; i2++) {
      var s = 0, c = 0;
      for (var k = -win; k <= win; k++) {
        var j = i2 + k;
        if (j < 0 || j >= raw.length) continue;
        s += raw[j]; c++;
      }
      sm[i2] = s / c;
    }
    return function (u) {
      var fi = Math.max(0, Math.min(sm.length - 1, u * n));
      var i0 = Math.floor(fi), t = fi - i0;
      var i1 = Math.min(sm.length - 1, i0 + 1);
      return sm[i0] * (1 - t) + sm[i1] * t;
    };
  })();
  var DECK_HEIGHT = groundProfile(U_RAMP_END) + VIADUCT_CLEARANCE;
  function railY(u) {
    if (u <= U_RAMP_START) return groundProfile(u);
    if (u >= U_RAMP_END) return DECK_HEIGHT;
    var t = smoothstep((u - U_RAMP_START) / (U_RAMP_END - U_RAMP_START));
    return groundProfile(u) * (1 - t) + DECK_HEIGHT * t;
  }
  pSakura.y = railY(uSakura);   // 駅名ラベル・初期カメラターゲット用に実際の高さを反映

  // 待避線のふくらみ：窓の外は本線と同じ、駅の中央で外へ開く（passing loop）
  // 桜上水と八幡山の2駅が待避駅
  function loopBumpAt(u, uStn) {
    // 10両編成(210m)のホーム全長で平行になるよう、±110mは全開・その外60mで閉じる台形
    var d = Math.abs(u - uStn) * LEN;
    if (d < 110) return 6.5;
    if (d < 170) return smoothstep(1 - (d - 110) / 60) * 6.5;
    return 0;
  }
  function loopBump(u) { return loopBumpAt(u, uSakura) + loopBumpAt(u, uHachi); }
  // 上北沢の島式ホームぶんのふくらみ：駅の前後で上下線が外へ開いて島を挟む
  var KAMI_WINDOW = 90 / LEN;
  function kamiBump(u) {
    // 島ホーム210m(10両)の全長で全開・その外60mで閉じる台形
    var d = Math.abs(u - uKami) * LEN;
    if (d < 105) return 1.3;
    if (d < 165) return smoothstep(1 - (d - 105) / 60) * 1.3;
    return 0;
  }

  // 横オフセット付きの線路カーブを作る（法線方向へずらす）
  function offsetCurve(baseOffsetFn) {
    var N = 560, pts = [];   // 全長3.2km→約6m間隔（待避線の開閉台形が滑らかに出る密度）
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var p = center.getPointAt(u);
      var tan = center.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;           // xz平面での法線
      var off = baseOffsetFn(u);
      pts.push(new THREE.Vector3(p.x + nx * off, railY(u), p.z + nz * off));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  }

  // 4本の線路：本線±2m（上北沢では島ホームを挟んで外へ開く）、待避線は桜上水で外へふくらむ
  var GAUGE = 1.6;
  var trackUpThrough = offsetCurve(function (u) { return 2.2 + kamiBump(u); });    // 上り本線
  var trackDnThrough = offsetCurve(function (u) { return -2.2 - kamiBump(u); });   // 下り本線（通過）
  var trackUpLoop = offsetCurve(function (u) { return 2.2 + kamiBump(u) + loopBump(u); });   // 上り待避
  var trackDnLoop = offsetCurve(function (u) { return -2.2 - kamiBump(u) - loopBump(u); });  // 下り待避

  [trackUpThrough, trackDnThrough, trackUpLoop, trackDnLoop].forEach(function (c) { buildTrack(c); });
  plantLineSideTrees();   // 沿線の並木（線路とPLATEAU建物の間の緩衝帯に植える）

  function plantLineSideTrees() {
    var spacing = 34, jitter = 10;
    var count = Math.floor(LEN / spacing) * 2;
    var crown = new THREE.InstancedMesh(
      new THREE.ConeGeometry(2.2, 5.2, 7),
      new THREE.MeshLambertMaterial({ color: 0x4d7a45 }), count);
    var trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.28, 0.36, 2.4, 5),
      new THREE.MeshLambertMaterial({ color: 0x6b5236 }), count);
    var m = new THREE.Matrix4();
    var idx = 0;
    for (var side = -1; side <= 1; side += 2) {
      for (var s = spacing / 2; s < LEN && idx < count; s += spacing) {
        var u = s / LEN;
        if (u >= U_RAMP_START) continue;                // 高架・築堤の区間は並木を省略(橋脚と干渉するため)
        if (Math.abs(u - uSakura) < WINDOW) continue;  // 駅構内には植えない
        if (Math.abs(u - uKami) < KAMI_WINDOW) continue;
        if (Math.abs(u - uShimo) < KAMI_WINDOW) continue;
        var p = center.getPointAt(Math.min(1, u)), tan = center.getTangentAt(Math.min(1, u));
        var nx = -tan.z, nz = tan.x;
        var off = side * (10.5 + ((idx * 7919) % 100) / 100 * jitter);
        var px = p.x + nx * off, pz = p.z + nz * off;
        var gy = terrainHeight(px, pz);                  // 木は線路ではなく自然の地面から生える
        var sc = 0.8 + ((idx * 104729) % 100) / 100 * 0.7;
        m.makeScale(sc, sc, sc);
        m.setPosition(px, gy + 3.6 * sc, pz);
        crown.setMatrixAt(idx, m);
        m.makeScale(1, sc, 1);
        m.setPosition(px, gy + 1.1 * sc, pz);
        trunk.setMatrixAt(idx, m);
        idx++;
      }
      if (idx >= count) break;
    }
    crown.count = idx; trunk.count = idx;
    crown.castShadow = true;
    scene.add(crown); scene.add(trunk);
  }

  // ---- 桜上水・八幡山（2面4線：島式ホーム2面。桜上水は橋上駅舎付き） ----
  buildIslandLoopStation(uSakura);
  buildIslandLoopStation(uHachi);
  buildBridgeStationHouse();
  // ---- 上北沢の駅（島式1面2線＋小さな駅舎） ----
  buildKamikitazawa(uKami);
  // ---- 下高井戸の駅（相対式2面2線。カーブ上のホーム） ----
  buildShimotakaido(uShimo);
  // ---- 高架橋（上北沢〜八幡山〜区間西端。実際に高架化済みの区間）＋八幡山の高架下駅舎 ----
  buildViaduct();
  buildElevatedStationHouse(uHachi);
  addLabel('桜上水', pSakura, 0x1b3a5b);
  addLabel('上北沢', new THREE.Vector3(stB[0], railY(uKami), stB[1]), 0x1b3a5b);
  addLabel('下高井戸', new THREE.Vector3(stC[0], railY(uShimo), stC[1]), 0x1b3a5b);
  addLabel('八幡山', new THREE.Vector3(stD[0], railY(uHachi), stD[1]), 0x1b3a5b);

  // ---- 列車 ----
  // 下り（東→西）：特急は本線を通過、各停は待避線で待つ
  var express = makeTrain('KEIO_5000', 5);  // 京王5000系（京王ライナー）＝通過の特急役・5両
  var local = makeTrain('KEIO_8000', 4);    // 京王8000系（各停）＝待避する各停・4両
  scene.add(express.group); scene.add(local.group);

  // ---- 待避のタイムライン（台本制御。本格信号は次スライスで） ----
  // 下り各停: 下高井戸→桜上水(待避)→上北沢→八幡山と各駅に停車。
  // 特急は各停が桜上水で待避している間に本線を通過して先へ抜ける
  var caption = document.getElementById('caption');

  // キーフレーム [時刻, u]。u同士が同じ区間=停車。区間の走行はease補間
  var locPlan = [
    [0, 0.0],
    [6, uShimo], [13, uShimo],        // 下高井戸 停車
    [28, uSakura], [46, uSakura],     // 桜上水 待避線で特急待ち
    [60, uKami], [66, uKami],         // 上北沢 停車
    [78, uHachi], [86, uHachi],       // 八幡山 到着・停車
  ];
  var expPlan = [[24, 0.0], [48, 1.0]];   // 特急: 東端→西端を一気に通過
  var CYCLE = 90;

  function planU(plan, t) {
    if (t <= plan[0][0]) return plan[0][1];
    for (var i = 1; i < plan.length; i++) {
      if (t <= plan[i][0]) {
        var a = plan[i - 1], b = plan[i];
        if (a[1] === b[1]) return a[1];
        return a[1] + (b[1] - a[1]) * ease((t - a[0]) / (b[0] - a[0]));
      }
    }
    return plan[plan.length - 1][1];
  }

  var T = 0;
  function updateTrains(dt) {
    T = (T + dt) % CYCLE;

    // --- 各停（下り待避線カーブ上を走る。待避駅以外では本線と同じ線形）---
    local.group.visible = T < 88;
    placeTrain(local, trackDnLoop, planU(locPlan, T));

    // --- 特急（下り本線）---
    var exVisible = T >= expPlan[0][0] && T <= expPlan[1][0] + 1;
    express.group.visible = exVisible;
    placeTrain(express, trackDnThrough, planU(expPlan, T));

    // 実況キャプション
    var c;
    if (T < 6) c = '各停、下高井戸へ';
    else if (T < 13) c = '下高井戸、停車中（世田谷線のりかえ）';
    else if (T < 28) c = '各停、桜上水へ。後ろから特急が迫ります';
    else if (T < 33) c = '各停は桜上水の待避線に入りました';
    else if (T < 42) c = '特急が本線を通過します！';
    else if (T < 46) c = '特急、通過。各停はまもなく発車';
    else if (T < 60) c = '各停、発車。上北沢へ';
    else if (T < 66) c = '上北沢、停車中';
    else if (T < 78) c = '各停、八幡山へ';
    else c = '八幡山、到着。（特急はこの先の芦花公園方面へ）';
    caption.textContent = c;
  }

  // ---- メインループ ----
  // ---- 前面展望（各停=8000系の運転台にカメラを置く） ----
  var viewMode = 'orbit';
  var savedCam = null;
  function setViewMode(mode) {
    viewMode = mode;
    var btn = document.getElementById('viewBtn');
    if (mode === 'cab') {
      savedCam = { pos: camera.position.clone(), target: controls.target.clone() };
      controls.enabled = false;
      if (btn) btn.textContent = '🚁 上空にもどる';
    } else {
      controls.enabled = true;
      if (savedCam) { camera.position.copy(savedCam.pos); controls.target.copy(savedCam.target); }
      if (btn) btn.textContent = '🚃 前面展望';
    }
  }
  var viewBtn = document.getElementById('viewBtn');
  if (viewBtn) viewBtn.addEventListener('click', function () { setViewMode(viewMode === 'cab' ? 'orbit' : 'cab'); });

  function updateCabCamera() {
    var t = local;                                   // 各停に乗る（待避中に特急が横を通過する）
    if (!t._curve) return;
    var L = t._curve.getLength();
    var headDist = t._uHead * L + 0.9;               // 先頭面のすぐ外＝前面ガラス位置（車体の中に入らない）
    var u = Math.max(0.001, Math.min(0.999, headDist / L));
    var p = t._curve.getPointAt(u);
    var tan = t._curve.getTangentAt(u);
    camera.position.set(p.x, p.y + 3.0, p.z);
    camera.lookAt(p.x + tan.x * 60, p.y + 2.0, p.z + tan.z * 60);
  }

  var last = performance.now(), booted = false;
  function animate(now) {
    var dt = Math.min((now - last) / 1000, 0.05); last = now;
    try {
      updateTrains(dt);
      if (viewMode === 'cab') updateCabCamera();
      else controls.update();
      renderer.render(scene, camera);
    } catch (e) {
      if (window.__boot) window.__boot('LOOP: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : ''));
      return;   // ループを止めて原因を表示（暴走 log を防ぐ）
    }
    if (!booted) { booted = true; var be = document.getElementById('boot'); if (be) be.style.display = 'none'; }
    requestAnimationFrame(animate);
  }
  controls.target.copy(pSakura);
  requestAnimationFrame(animate);

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ====================== 部品づくり ======================

  // 線路：バラスト（帯）＋2本のレール＋枕木（インスタンス）
  function buildTrack(curve) {
    var N = 480;   // 3.2kmで約7m間隔
    var pts = curve.getSpacedPoints(N);
    // バラスト帯
    var ballastGeo = ribbonGeometry(curve, N, 1.9, 0.02);
    var ballast = new THREE.Mesh(ballastGeo, new THREE.MeshLambertMaterial({ color: 0x8a8378, side: THREE.DoubleSide }));
    ballast.receiveShadow = true; scene.add(ballast);
    // レール2本
    [GAUGE / 2, -GAUGE / 2].forEach(function (off) {
      var railPts = [];
      for (var i = 0; i <= N; i++) {
        var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        railPts.push(new THREE.Vector3(p.x + nx * off, 0.15, p.z + nz * off));
      }
      var railCurve = new THREE.CatmullRomCurve3(railPts);
      var rail = new THREE.Mesh(
        new THREE.TubeGeometry(railCurve, N, 0.08, 6, false),
        new THREE.MeshStandardMaterial({ color: 0x5a5f66, metalness: 0.8, roughness: 0.4 })
      );
      rail.castShadow = true; scene.add(rail);
    });
    // 枕木（InstancedMesh）
    var step = 3, count = Math.floor(curve.getLength() / step);
    var tie = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.5, 0.12, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x6b5842 }), count);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < count; i++) {
      var u = i / count, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var ang = Math.atan2(tan.x, tan.z);
      q.setFromAxisAngle(up, ang);
      m.compose(new THREE.Vector3(p.x, 0.06, p.z), q, new THREE.Vector3(1, 1, 1));
      tie.setMatrixAt(i, m);
    }
    tie.receiveShadow = true; scene.add(tie);
  }

  // 中心カーブに沿った平らな帯（バラスト用）。yはカーブ自身の高さ(p.y)からの相対オフセット
  function ribbonGeometry(curve, N, halfW, y) {
    var pos = [], idx = [];
    for (var i = 0; i <= N; i++) {
      var u = i / N, p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      var nx = -tan.z, nz = tan.x;
      pos.push(p.x + nx * halfW, p.y + y, p.z + nz * halfW);
      pos.push(p.x - nx * halfW, p.y + y, p.z - nz * halfW);
    }
    for (var i = 0; i < N; i++) {
      var a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  // 2面4線の待避駅（桜上水・八幡山）：2面の島式ホーム＋上屋
  function buildIslandLoopStation(uStn) {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4, side: THREE.DoubleSide });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x3a4a5a, side: THREE.DoubleSide });
    // 島式ホームは「本線(±2.2)と待避線(±8.7)の真ん中」＝±5.45。幅は車両限界に合わせる
    [5.45, -5.45].forEach(function (side) {
      var slabPts = [];
      for (var i = 0; i <= 40; i++) {
        var u = uStn - 105 / LEN + (210 / LEN) * (i / 40);   // 実物の10両対応=210mホーム
        if (u < 0 || u > 1) continue;
        var p = center.getPointAt(u), tan = center.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        // ホーム中心も膨らみに追従（本線と待避線の中点）
        var mid = side > 0 ? (2.2 + 2.2 + loopBump(u)) / 2 : -(2.2 + 2.2 + loopBump(u)) / 2;
        slabPts.push(new THREE.Vector3(p.x + nx * mid, railY(u), p.z + nz * mid));
      }
      if (slabPts.length < 2) return;
      var slabCurve = new THREE.CatmullRomCurve3(slabPts);
      var slab = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 1.45, 0.9),
        pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      // 上屋（薄い屋根）
      var roof = new THREE.Mesh(ribbonRaised(slabCurve, slabPts.length * 3, 1.7, 4.4), roofmat);
      scene.add(roof);
    });
  }

  // 下高井戸：相対式2面2線（カーブ上のサイドホーム）＋小さな上屋
  function buildShimotakaido(uStn) {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4, side: THREE.DoubleSide });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x4a4a5a, side: THREE.DoubleSide });
    [5.2, -5.2].forEach(function (side) {
      var pts = [];
      for (var i = 0; i <= 40; i++) {
        var u = uStn - 105 / LEN + (210 / LEN) * (i / 40);   // 10両対応210m
        if (u < 0 || u > 1) continue;
        var p = center.getPointAt(u), tan = center.getTangentAt(u);
        var nx = -tan.z, nz = tan.x;
        pts.push(new THREE.Vector3(p.x + nx * side, railY(u), p.z + nz * side));
      }
      if (pts.length < 2) return;
      var cv = new THREE.CatmullRomCurve3(pts);
      var slab = new THREE.Mesh(ribbonRaised(cv, pts.length * 3, 1.4, 0.9), pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      var roof = new THREE.Mesh(ribbonRaised(cv, pts.length * 3, 1.6, 4.4), roofmat);
      scene.add(roof);
    });
  }

  // 桜上水の橋上駅舎：線路をまたぐ箱＋支柱
  function buildBridgeStationHouse() {
    var p = center.getPointAt(uSakura), tan = center.getTangentAt(uSakura);
    var g = new THREE.Group();
    g.position.set(p.x, railY(uSakura), p.z);
    g.rotation.y = Math.atan2(tan.x, tan.z);
    var wall = new THREE.MeshLambertMaterial({ color: 0xe8e2d6 });
    var glass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, metalness: 0.4, roughness: 0.3 });
    var roof = new THREE.MeshLambertMaterial({ color: 0x40556a });
    var body = new THREE.Mesh(new THREE.BoxGeometry(26, 3.4, 13), wall);
    body.position.y = 8.2; body.castShadow = true; g.add(body);
    var win = new THREE.Mesh(new THREE.BoxGeometry(26.1, 1.2, 13.1), glass);
    win.position.y = 8.4; g.add(win);
    var top = new THREE.Mesh(new THREE.BoxGeometry(27.5, 0.5, 14.5), roof);
    top.position.y = 10.1; g.add(top);
    [[-11, 5], [-11, -5], [11, 5], [11, -5]].forEach(function (o) {
      var leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6.5, 1.1), wall);
      leg.position.set(o[0], 3.25, o[1]); leg.castShadow = true; g.add(leg);
    });
    scene.add(g);
  }

  // 上北沢：島式1面2線（上下線に挟まれた島ホーム）＋構内踏切側の小さな駅舎
  function buildKamikitazawa(uK) {
    var pmat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4, side: THREE.DoubleSide });
    var roofmat = new THREE.MeshLambertMaterial({ color: 0x4a5a4a, side: THREE.DoubleSide });
    var LEN2 = 105 / LEN;                        // ±105m＝実物の10両対応210mホーム
    // 島ホーム＝中心線上（線路は±2mなので、その内側1面）
    var pts = [];
    for (var i = 0; i <= 30; i++) {
      var u = uK - LEN2 + (LEN2 * 2) * (i / 30);
      if (u < 0 || u > 1) continue;
      var pt = center.getPointAt(u);
      pt.y = railY(u);
      pts.push(pt);
    }
    if (pts.length >= 2) {
      var cv = new THREE.CatmullRomCurve3(pts);
      var slab = new THREE.Mesh(ribbonGeometry(cv, pts.length * 3, 1.7, 0.9), pmat);
      slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
      var roof = new THREE.Mesh(ribbonGeometry(cv, pts.length * 3, 1.9, 4.2), roofmat);
      scene.add(roof);
    }
    // 駅舎（ホーム端の脇に小さな箱＝駅出入口のイメージ）
    var uEnd = Math.min(1, uK + LEN2);
    var p = center.getPointAt(uEnd), tan = center.getTangentAt(uEnd);
    var nx = -tan.z, nz = tan.x;
    var house = new THREE.Group();
    house.position.set(p.x + nx * 7, railY(uEnd), p.z + nz * 7);
    house.rotation.y = Math.atan2(tan.x, tan.z);
    var hw = new THREE.MeshLambertMaterial({ color: 0xefe8da });
    var hb = new THREE.Mesh(new THREE.BoxGeometry(7, 3.6, 5), hw);
    hb.position.y = 1.8; hb.castShadow = true; house.add(hb);
    var hr = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 6), new THREE.MeshLambertMaterial({ color: 0x8a4a3a }));
    hr.position.y = 3.8; house.add(hr);
    scene.add(house);
  }

  // 高架橋：ランプ区間は土盛りの築堤(高さに応じた箱を並べる簡易表現)、
  // 本設の高架区間は橋脚(等間隔の柱＋柱頭)＋桁(箱を連ねた低ポリ表現)
  function buildViaduct() {
    if (U_RAMP_END >= 1) return;   // 区間内に高架が存在しない場合は何もしない
    var embankMat = new THREE.MeshLambertMaterial({ color: 0x8c7f63 });
    var deckMat = new THREE.MeshLambertMaterial({ color: 0x9a9a92 });
    var pierMat = new THREE.MeshLambertMaterial({ color: 0x87867e });
    var DECK_HALF_W = 11.5, DECK_THICK = 1.3, DECK_GAP = 0.3;   // 桁上面=railY-0.3(バラスト厚みぶん)

    // ランプ区間：土盛りの築堤
    var rampStep = 8, rampStepU = rampStep / LEN;
    for (var u = U_RAMP_START; u < U_RAMP_END; u += rampStepU) {
      var p = center.getPointAt(u), tan = center.getTangentAt(u);
      var gy = terrainHeight(p.x, p.z), topY = railY(u) - DECK_GAP;
      var height = Math.max(0.3, topY - gy);
      var box = new THREE.Mesh(new THREE.BoxGeometry(DECK_HALF_W * 2 - 3, height, rampStep + 0.6), embankMat);
      box.position.set(p.x, gy + height / 2, p.z);
      box.rotation.y = Math.atan2(tan.x, tan.z);
      box.castShadow = true; box.receiveShadow = true;
      scene.add(box);
    }

    // 高架区間：桁(連続した箱を並べる。低ポリの方針に合わせ単純な形状に統一)
    var deckStep = 10, deckStepU = deckStep / LEN;
    for (var u2 = U_RAMP_END; u2 < 1; u2 += deckStepU) {
      var p2 = center.getPointAt(u2), tan2 = center.getTangentAt(u2);
      var topY2 = railY(u2) - DECK_GAP;
      var deckBox = new THREE.Mesh(new THREE.BoxGeometry(DECK_HALF_W * 2, DECK_THICK, deckStep + 0.5), deckMat);
      deckBox.position.set(p2.x, topY2 - DECK_THICK / 2, p2.z);
      deckBox.rotation.y = Math.atan2(tan2.x, tan2.z);
      deckBox.castShadow = true; deckBox.receiveShadow = true;
      scene.add(deckBox);
    }

    // 高架区間：橋脚(等間隔の柱＋柱頭)
    var pierSpacing = 24, pierStepU = pierSpacing / LEN;
    for (var u3 = U_RAMP_END + pierStepU * 0.5; u3 < 1; u3 += pierStepU) {
      var p3 = center.getPointAt(u3), tan3 = center.getTangentAt(u3);
      var deckBottomY = railY(u3) - DECK_GAP - DECK_THICK;
      var gy3 = terrainHeight(p3.x, p3.z);
      var h3 = Math.max(0.5, deckBottomY - gy3);
      var ang = Math.atan2(tan3.x, tan3.z);
      var col = new THREE.Mesh(new THREE.BoxGeometry(2.2, h3, 3.2), pierMat);
      col.position.set(p3.x, gy3 + h3 / 2, p3.z);
      col.rotation.y = ang;
      col.castShadow = true; col.receiveShadow = true;
      scene.add(col);
      var cap = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.7, 4.4), pierMat);
      cap.position.set(p3.x, deckBottomY - 0.35, p3.z);
      cap.rotation.y = ang;
      cap.castShadow = true;
      scene.add(cap);
    }
  }

  // 八幡山：高架下の改札コンコース＋ホームへのガラス張り階段室
  function buildElevatedStationHouse(uStn) {
    var p = center.getPointAt(uStn), tan = center.getTangentAt(uStn);
    var gy = terrainHeight(p.x, p.z), py = railY(uStn);
    var g = new THREE.Group();
    g.position.set(p.x, gy, p.z);
    g.rotation.y = Math.atan2(tan.x, tan.z);
    var wall = new THREE.MeshLambertMaterial({ color: 0xe8e2d6 });
    var glass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, metalness: 0.4, roughness: 0.3 });
    var concourse = new THREE.Mesh(new THREE.BoxGeometry(22, 4.2, 16), wall);
    concourse.position.y = 2.1; concourse.castShadow = true; g.add(concourse);
    var win = new THREE.Mesh(new THREE.BoxGeometry(22.1, 1.6, 16.1), glass);
    win.position.y = 3.0; g.add(win);
    var stairH = Math.max(1, (py - gy) - 3.5);
    [-9, 9].forEach(function (x) {
      var stair = new THREE.Mesh(new THREE.BoxGeometry(4.5, stairH, 5.5), glass);
      stair.position.set(x, 4.2 + stairH / 2, 0);
      stair.castShadow = true; g.add(stair);
    });
    scene.add(g);
  }

  // 高さのある帯（ホーム床/屋根）: 上面のみの板を y に置く
  function ribbonRaised(curve, N, halfW, y) {
    return (function () {
      var g = ribbonGeometry(curve, N, halfW, y);
      return g;
    })();
  }

  // 列車：形式ごとの塗装で、先頭〜後尾の車をつなぐ
  function makeTrain(typeKey, cars) {
    var t = TRAIN_TYPES[typeKey] || TRAIN_TYPES.KEIO_8000;
    var group = new THREE.Group();
    var baseMat = new THREE.MeshStandardMaterial({ color: t.base, metalness: 0.35, roughness: 0.5 });
    var roofMat = new THREE.MeshStandardMaterial({ color: t.roof, metalness: 0.3, roughness: 0.6 });
    var winMat = new THREE.MeshStandardMaterial({ color: 0x10161f, metalness: 0.6, roughness: 0.25 });
    var frontMat = new THREE.MeshStandardMaterial({ color: t.front, metalness: 0.4, roughness: 0.4 });
    var lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6d6, emissive: 0x554400, emissiveIntensity: 0.5 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x333840, metalness: 0.6, roughness: 0.4 });
    var W = 2.9, H = 3.4, CAR = 18, GAP = 2;
    var arr = [];
    for (var i = 0; i < cars; i++) {
      var c = new THREE.Group();
      // 車体
      var b = new THREE.Mesh(new THREE.BoxGeometry(W, H, CAR), baseMat); b.position.y = 2.0; b.castShadow = true; c.add(b);
      // 側面の窓帯
      var w = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 1.0, CAR * 0.86), winMat); w.position.y = 2.55; c.add(w);
      // 形式の帯（側面の横ストライプ）
      t.bands.forEach(function (bd) {
        var band = new THREE.Mesh(new THREE.BoxGeometry(W + 0.06, bd.h, CAR * 0.99),
          new THREE.MeshStandardMaterial({ color: bd.color, metalness: 0.2, roughness: 0.5 }));
        band.position.y = bd.y; c.add(band);
      });
      // 屋根＋クーラー
      var roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, 0.45, CAR * 0.96), roofMat); roof.position.y = 3.75; c.add(roof);
      for (var k = 0; k < 2; k++) {
        var ac = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 2.4), roofMat); ac.position.set(0, 4.05, -4.5 + k * 9); c.add(ac);
      }
      // パンタグラフ（2両目に）
      if (i === 1) {
        var pgBase = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.4), darkMat); pgBase.position.set(0, 4.2, 3); c.add(pgBase);
        var pgArm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.1), darkMat); pgArm.position.set(0, 4.6, 3); pgArm.rotation.x = 0.5; c.add(pgArm);
      }
      // 先頭車の前面（+Z端）
      if (i === 0) {
        var fp = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.94, 0.5), frontMat); fp.position.set(0, 2.05, CAR / 2 + 0.1); fp.castShadow = true; c.add(fp);
        var fw = new THREE.Mesh(new THREE.BoxGeometry(W * 0.66, 1.15, 0.55), winMat); fw.position.set(0, 2.8, CAR / 2 + 0.16); c.add(fw);
        [-0.95, 0.95].forEach(function (x) {
          var lm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.3), lampMat); lm.position.set(x, 1.45, CAR / 2 + 0.22); c.add(lm);
        });
        // 種別・行先の光る表示（形式のアクセント色）
        var ds = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.42, 0.3),
          new THREE.MeshStandardMaterial({ color: t.accent, emissive: t.accent, emissiveIntensity: 0.35 }));
        ds.position.set(0, 3.4, CAR / 2 + 0.2); c.add(ds);
      }
      c.userData.spacing = i * (CAR + GAP);
      group.add(c); arr.push(c);
    }
    return { group: group, cars: arr, carLen: CAR + GAP, total: cars * (CAR + GAP), typeName: t.name };
  }

  // 列車をカーブ上の位置 u（先頭）に配置。各車を後ろへ並べて向きも合わせる
  function placeTrain(train, curve, uHead) {
    train._curve = curve; train._uHead = uHead;   // 前面展望カメラ用に記録
    var L = curve.getLength();
    train.cars.forEach(function (c) {
      var dist = uHead * L - c.userData.spacing - 9;   // 車体中心
      var u = Math.max(0, Math.min(1, dist / L));
      var p = curve.getPointAt(u), tan = curve.getTangentAt(u);
      c.position.set(p.x, p.y, p.z);
      c.rotation.y = Math.atan2(tan.x, tan.z);
    });
  }

  // 駅名ラベル（キャンバス→スプライト。常にカメラを向く）
  function addLabel(text, pos, color) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; roundRect(ctx, 6, 20, 244, 56, 14); ctx.fill();
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 44px "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 50);
    var tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.position.set(pos.x, pos.y + 22, pos.z); sp.scale.set(34, 12.75, 1);
    scene.add(sp);
  }

  // 沿線の実在建物（OSMのフットプリント＋高さ）を1つのメッシュに合成して建てる
  function buildRealBuildings() {
    if (typeof BUILDINGS === 'undefined' || !BUILDINGS.length) return;
    var palette = [
      [0.85, 0.82, 0.76], [0.80, 0.76, 0.70], [0.88, 0.88, 0.88],
      [0.78, 0.72, 0.66], [0.83, 0.79, 0.72], [0.75, 0.78, 0.80]
    ];
    var pos = [], col = [];
    function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, c) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (var k = 0; k < 3; k++) col.push(c[0], c[1], c[2]);
    }
    for (var bi = 0; bi < BUILDINGS.length; bi++) {
      var b = BUILDINGS[bi], poly = b.p, h = b.h;
      var cx = 0, cz = 0;
      for (var pi = 0; pi < poly.length; pi++) { cx += poly[pi][0]; cz += poly[pi][1]; }
      cx /= poly.length; cz /= poly.length;
      var fy = terrainHeight(cx, cz);   // 建物1棟につき1つの基礎高（実際の建築と同様、1枚の水平な基礎）
      var baseColor = palette[bi % palette.length];
      var roofC = [baseColor[0] * 0.82, baseColor[1] * 0.82, baseColor[2] * 0.84];
      // 壁（各辺を2三角形で）
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], c2 = poly[(i + 1) % poly.length];
        pushTri(a[0], fy, a[1], c2[0], fy, c2[1], c2[0], fy + h, c2[1], baseColor);
        pushTri(a[0], fy, a[1], c2[0], fy + h, c2[1], a[0], fy + h, a[1], baseColor);
      }
      // 屋根（多角形を三角形分割）
      var v2 = poly.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
      var tris = THREE.ShapeUtils.triangulateShape(v2, []);
      for (var t2 = 0; t2 < tris.length; t2++) {
        var i0 = tris[t2][0], i1 = tris[t2][1], i2 = tris[t2][2];
        pushTri(poly[i0][0], fy + h, poly[i0][1], poly[i1][0], fy + h, poly[i1][1], poly[i2][0], fy + h, poly[i2][1], roofC);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    var mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // ====================== ヘルパー ======================
  function smoothstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  function ease(t) { t = Math.max(0, Math.min(1, t)); return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function nearestU(curve, target) {
    var best = 0, bd = Infinity;
    for (var i = 0; i <= 1000; i++) {   // 3.2kmで約3.2m刻み
      var u = i / 1000, p = curve.getPointAt(u), d = p.distanceToSquared(target);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
})();
