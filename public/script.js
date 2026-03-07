async function search(){

    let q = document.getElementById("searchBox").value
    
    let res = await fetch(`/api/search?q=${q}`)
    
    let data = await res.json()
    
    let results = document.getElementById("results")
    
    results.innerHTML=""
    
    data.Search.forEach(m=>{
    
    results.innerHTML += `
    
    <div class="card">
    
    <img src="${m.Poster}">
    
    <h3>${m.Title}</h3>
    
    <a href="movie.html?id=${m.imdbID}">
    Details
    </a>
    
    <button onclick='addWatch(${JSON.stringify(m)})'>
    Add Watchlist
    </button>
    
    </div>
    
    `
    
    })
    
    }
    
    async function addWatch(movie){
    
    await fetch("/api/watchlist",{
    
    method:"POST",
    
    headers:{
    "Content-Type":"application/json"
    },
    
    body:JSON.stringify(movie)
    
    })
    
    loadData()
    
    }
    
    async function markWatched(movie){
    
    movie.rating = prompt("Rating (1-10)")
    movie.date = prompt("Watch date (YYYY-MM-DD)")
    
    await fetch("/api/watched",{
    
    method:"POST",
    
    headers:{
    "Content-Type":"application/json"
    },
    
    body:JSON.stringify(movie)
    
    })
    
    loadData()
    
    }
    
    async function loadData(){
    
    let res = await fetch("/api/data")
    
    let data = await res.json()
    
    let watchlist = document.getElementById("watchlist")
    let watched = document.getElementById("watched")
    
    watchlist.innerHTML=""
    watched.innerHTML=""
    
    data.watchlist.forEach(m=>{
    
    watchlist.innerHTML += `
    
    <div class="card">
    
    <img src="${m.Poster}">
    <h3>${m.Title}</h3>
    
    <button onclick='markWatched(${JSON.stringify(m)})'>
    Watched
    </button>
    
    </div>
    
    `
    
    })
    
    data.watched.forEach(m=>{
    
    watched.innerHTML += `
    
    <div class="card">
    
    <img src="${m.Poster}">
    <h3>${m.Title}</h3>
    
    ⭐ ${m.rating}
    <br>
    📅 ${m.date}
    
    </div>
    
    `
    
    })
    
    }
    
    function toggleTheme(){
    
    document.body.classList.toggle("light")
    
    }
    
    loadData()